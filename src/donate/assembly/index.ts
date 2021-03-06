import {context, ContractPromise, ContractPromiseBatch, env, logging, PersistentSet, storage, u128} from 'near-sdk-as';
import {
  AccountId,
  Amount, asNEAR,
  MIN_ACCOUNT_BALANCE,
  MIN_DONATION_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
  PLATFORM_FEE_DIVISOR,
  XCC_GAS
} from "../../utils";
import {DonationSentArgs, Donation, DonationsWithdrawnArgs} from "./models";


const OWNER_STORAGE_KEY = "o"
const BALANCE_STORAGE_KEY = "b"

@nearBindgen
export class Contract {

  donations: PersistentSet<Donation> = new PersistentSet<Donation>("d")

  init(owner: AccountId): void {
    // contract may only be initialized once
    assert(!this.is_initialized(), "Contract is already initialized.")

    // storing donate metadata requires some storage staking (balance locked to offset cost of data storage)
    assert(
        u128.ge(context.attachedDeposit, MIN_ACCOUNT_BALANCE),
        "Minimum account balance must be attached to initialize this contract (3 NEAR)"
    )

    assert(env.isValidAccountID(owner), "Owner account must have valid NEAR account name")

    storage.set(OWNER_STORAGE_KEY, owner)
    storage.set(BALANCE_STORAGE_KEY, u128.Zero)

    logging.log("donation account was created")
  }

  send_donation(): void {
    this.assert_contract_is_initialized()

    assert(
        u128.ge(context.attachedDeposit, MIN_DONATION_AMOUNT),
        "Minimum donation must be attached (1 NEAR)"
    )

    const feeAmount = u128.div(context.attachedDeposit, PLATFORM_FEE_DIVISOR)
    const donationAmount = u128.sub(context.attachedDeposit, feeAmount)

    const promise = ContractPromiseBatch.create(this.get_factory())
        .function_call(
            "deposit_fees",
            "{}",
            feeAmount,
            XCC_GAS
        )

    promise.then(context.contractName).function_call(
        "on_donation_sent",
        new DonationSentArgs(donationAmount),
        u128.Zero,
        XCC_GAS
    )
  }

  on_donation_sent(amount: Amount): void {
    let results = ContractPromise.getResults();
    let donate = results[0];

    // Verifying the remote contract call succeeded.
    // https://nomicon.io/RuntimeSpec/Components/BindingsSpec/PromisesAPI.html?highlight=promise#returns-3
    switch (donate.status) {
      case 0:
        // promise result is not complete
        logging.log("Donation is pending")
        break;
      case 1:
        // promise result is complete and successful
        logging.log(`Successfully received ${asNEAR(amount)} NEAR donation`)
        storage.set(BALANCE_STORAGE_KEY, u128.add(this.get_balance(), amount))
        this.donations.add(new Donation(context.predecessor, amount, context.blockTimestamp))
        break;
      case 2:
        // promise result is complete and failed
        logging.log("Donation failed")
        break;

      default:
        logging.log("Unexpected value for promise result [" + donate.status.toString() + "]");
        break;
    }
  }

  withdraw_donations(amount: Amount): void {
    this.assert_contract_is_initialized()
    this.assert_signed_by_owner()

    assert(
        u128.ge(amount, MIN_WITHDRAWAL_AMOUNT),
        'Attempting to withdraw less than minimum amount (1 NEAR)'
    )

    const owner = context.predecessor
    const balance = storage.getSome<u128>(BALANCE_STORAGE_KEY)

    assert(
        u128.le(amount, balance),
        'Attempting to withdraw more than donation balance.'
    )

    storage.set(BALANCE_STORAGE_KEY, u128.sub(balance, amount))

    const promise = ContractPromiseBatch.create(owner)
        .transfer(amount)

    promise.then(context.contractName).function_call(
        "on_donations_withdrawn",
        new DonationsWithdrawnArgs(amount),
        u128.Zero,
        XCC_GAS
    )
  }

  on_donations_withdrawn(amount: Amount): void {
    let results = ContractPromise.getResults();
    let donationsWithdrawn = results[0];

    // Verifying the remote contract call succeeded.
    // https://nomicon.io/RuntimeSpec/Components/BindingsSpec/PromisesAPI.html?highlight=promise#returns-3
    switch (donationsWithdrawn.status) {
      case 0:
        // promise result is not complete
        logging.log("Donation withdrawal is pending")
        break;
      case 1:
        // promise result is complete and successful
        logging.log(`Successfully withdrawn ${asNEAR(amount)} NEAR of donations`)
        break;
      case 2:
        // promise result is complete and failed
        logging.log("Donation withdrawal failed")
        storage.set(BALANCE_STORAGE_KEY, u128.add(this.get_balance(), amount))
        break;

      default:
        logging.log("Unexpected value for promise result [" + donationsWithdrawn.status.toString() + "]");
        break;
    }
  }

  /**
   * Get list of donations received by this account.
   * TODO: Can we query list of function_call from NEAR blockchain?
   */
  get_donations(): Donation[] {
    this.assert_contract_is_initialized()

    return this.donations.values()
  }

  get_owner(): AccountId {
    this.assert_contract_is_initialized()

    return storage.getSome<string>(OWNER_STORAGE_KEY)
  }

  get_balance(): Amount {
    this.assert_contract_is_initialized()

    return storage.getSome<u128>(BALANCE_STORAGE_KEY)
  }

  get_factory(): AccountId {
    // The factory account is the parent account of this contract
    return context.contractName.split('.').splice(1).join('.')
  }

  private is_initialized(): bool {
    return storage.hasKey(OWNER_STORAGE_KEY) && storage.hasKey(BALANCE_STORAGE_KEY)
  }

  private assert_contract_is_initialized(): void {
    assert(this.is_initialized(), "Contract must be initialized first.")
  }

  private is_owner(): bool {
    return context.predecessor == storage.getString(OWNER_STORAGE_KEY)
  }

  private assert_signed_by_owner(): void {
    assert(this.is_owner(), "Must be called by owner. e.g. myorg.near if your donation account is myorg.donate.near")
  }
}
