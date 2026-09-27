/**
 * Anchor tests for alchemy_vessel (Stage 2).
 *
 * Covers the v1 custody model: the vessel PDA owns one Token-2022 token
 * account per (vessel, asset mint) ("custody account"), a VesselHolding PDA
 * mirrors the ledger, and every deposit/withdrawal asserts
 * holding.amount == custody balance (HoldingMismatch otherwise).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createAccount,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createMint,
  getAccount,
  getMintLen,
  mintTo,
  transferChecked,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("alchemy_vessel", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyVessel as Program;
  const connection = provider.connection;

  let funder: Keypair;

  before(async () => {
    funder = Keypair.generate();
    const sig = await connection.requestAirdrop(funder.publicKey, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  });

  const bn = (v: bigint | number) => new anchor.BN(v.toString());

  const vesselPda = (containerMint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vessel"), containerMint.toBuffer()],
      program.programId,
    )[0];

  const holdingPda = (vessel: PublicKey, assetMint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("holding"), vessel.toBuffer(), assetMint.toBuffer()],
      program.programId,
    )[0];

  const custodyPda = (vessel: PublicKey, assetMint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("custody"), vessel.toBuffer(), assetMint.toBuffer()],
      program.programId,
    )[0];

  interface VesselFixture {
    containerMint: PublicKey;
    vessel: PublicKey;
    depositAuthority: Keypair;
    withdrawAuthority: Keypair;
  }

  async function initVessel(opts?: {
    depositAuthority?: Keypair;
    withdrawAuthority?: Keypair;
  }): Promise<VesselFixture> {
    const containerMint = await createMint(
      connection,
      funder,
      funder.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const depositAuthority = opts?.depositAuthority ?? Keypair.generate();
    const withdrawAuthority = opts?.withdrawAuthority ?? Keypair.generate();
    // Authorities pay rent for first-time PDA creation on deposit.
    for (const kp of [depositAuthority, withdrawAuthority]) {
      const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }
    const vessel = vesselPda(containerMint);
    await program.methods
      .initializeVessel(
        TOKEN_2022_PROGRAM_ID,
        depositAuthority.publicKey,
        withdrawAuthority.publicKey,
      )
      .accounts({
        authority: funder.publicKey,
        vessel,
        containerMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();
    return { containerMint, vessel, depositAuthority, withdrawAuthority };
  }

  async function makeAssetMint(): Promise<PublicKey> {
    return createMint(
      connection,
      funder,
      funder.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  /** Create a Token-2022 token account for `owner` and mint `amount` into it. */
  async function fundTokenAccount(
    mint: PublicKey,
    owner: PublicKey,
    amount: bigint,
  ): Promise<PublicKey> {
    const acct = await createAccount(
      connection,
      funder,
      mint,
      owner,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      connection,
      funder,
      mint,
      acct,
      funder.publicKey,
      amount,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    return acct;
  }

  async function doDeposit(
    v: VesselFixture,
    assetMint: PublicKey,
    depositor: Keypair,
    depositorAccount: PublicKey,
    amount: bigint,
  ) {
    await program.methods
      .depositAsset(bn(amount))
      .accounts({
        depositAuthority: depositor.publicKey,
        vessel: v.vessel,
        containerMint: v.containerMint,
        assetMint,
        depositorAssetAccount: depositorAccount,
        holding: holdingPda(v.vessel, assetMint),
        custodyAccount: custodyPda(v.vessel, assetMint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();
  }

  async function doWithdraw(
    v: VesselFixture,
    assetMint: PublicKey,
    withdrawer: Keypair,
    destination: PublicKey,
    amount: bigint,
  ) {
    await program.methods
      .withdrawAsset(bn(amount))
      .accounts({
        withdrawAuthority: withdrawer.publicKey,
        vessel: v.vessel,
        containerMint: v.containerMint,
        assetMint,
        holding: holdingPda(v.vessel, assetMint),
        custodyAccount: custodyPda(v.vessel, assetMint),
        destination,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([withdrawer])
      .rpc();
  }

  /** Create a Token-2022 mint carrying a permanent-delegate extension. */
  async function createMintWithPermanentDelegate(): Promise<PublicKey> {
    const delegate = Keypair.generate().publicKey;
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.PermanentDelegate]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: funder.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        delegate,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        6,
        funder.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [funder, mint]);
    return mint.publicKey;
  }

  const tokenBalance = async (account: PublicKey): Promise<bigint> => {
    const acc = await getAccount(connection, account, undefined, TOKEN_2022_PROGRAM_ID);
    return acc.amount;
  };

  // Cast through `any`: without generated IDL types the account namespace
  // is untyped (same reason curve.ts needs its `: any` casts below).
  const fetchVessel = async (vessel: PublicKey): Promise<any> =>
    (program.account as any).vesselConfig.fetch(vessel);

  const fetchHolding = async (holding: PublicKey): Promise<any> =>
    (program.account as any).vesselHolding.fetch(holding);

  async function expectAnchorError(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
    } catch (err: any) {
      const actual = err?.error?.errorCode?.code;
      assert.strictEqual(
        actual,
        code,
        `expected Anchor error ${code}, got ${actual}: ${err?.message ?? err}`,
      );
      return;
    }
    assert.fail(`expected Anchor error ${code} but the transaction succeeded`);
  }

  // -------------------------------------------------------------------------

  it("initializes the vessel: signer becomes owner, custody pinned to Token-2022", async () => {
    const v = await initVessel();
    const config: any = await fetchVessel(v.vessel);
    assert.strictEqual(config.containerMint.toBase58(), v.containerMint.toBase58());
    assert.strictEqual(config.currentOwner.toBase58(), funder.publicKey.toBase58());
    assert.strictEqual(config.custodyProgram.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.strictEqual(config.depositAuthority.toBase58(), v.depositAuthority.publicKey.toBase58());
    assert.strictEqual(config.withdrawAuthority.toBase58(), v.withdrawAuthority.publicKey.toBase58());
    assert.strictEqual(BigInt(config.assetCount.toString()), 0n);
  });

  it("rejects default pubkeys and non-Token-2022 custody programs at init", async () => {
    const containerMint = await makeAssetMint();
    const vessel = vesselPda(containerMint);
    const init = (custody: PublicKey, dep: PublicKey, wd: PublicKey) =>
      program.methods
        .initializeVessel(custody, dep, wd)
        .accounts({
          authority: funder.publicKey,
          vessel,
          containerMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([funder])
        .rpc();

    const stranger = Keypair.generate().publicKey;
    await expectAnchorError(
      init(PublicKey.default, stranger, stranger),
      "InvalidPubkey",
    );
    await expectAnchorError(
      init(TOKEN_2022_PROGRAM_ID, PublicKey.default, stranger),
      "InvalidPubkey",
    );
    // A non-Token-2022 custody program would make the disclosed record a lie.
    await expectAnchorError(
      init(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), stranger, stranger),
      "InvalidCustodyProgram",
    );
  });

  it("deposit by the authorized key: balances, holding record, and invariant", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );

    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);

    // Tokens moved depositor -> custody PDA.
    assert.strictEqual(await tokenBalance(depositorAccount), 600n);
    const custody = custodyPda(v.vessel, assetMint);
    assert.strictEqual(await tokenBalance(custody), 400n);
    // The custody account is a Token-2022 account whose authority is the vessel PDA.
    const custodyInfo = await getAccount(connection, custody, undefined, TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(custodyInfo.owner.toBase58(), v.vessel.toBase58());
    assert.strictEqual(custodyInfo.mint.toBase58(), assetMint.toBase58());

    // Holding record mirrors the custody balance (the invariant).
    const holding: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(holding.vessel.toBase58(), v.vessel.toBase58());
    assert.strictEqual(holding.assetMint.toBase58(), assetMint.toBase58());
    assert.strictEqual(BigInt(holding.amount.toString()), 400n);
    assert.strictEqual(BigInt(holding.amount.toString()), await tokenBalance(custody));

    const config: any = await fetchVessel(v.vessel);
    assert.strictEqual(BigInt(config.assetCount.toString()), 1n);

    // A second deposit of the same asset does not re-register the mint.
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 100n);
    const holding2: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holding2.amount.toString()), 500n);
    assert.strictEqual(await tokenBalance(custody), 500n);
    const config2: any = await fetchVessel(v.vessel);
    assert.strictEqual(BigInt(config2.assetCount.toString()), 1n);
  });

  it("rejects deposits from an unauthorized key", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const stranger = Keypair.generate();
    const fundSig = await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(fundSig);
    const strangerAccount = await fundTokenAccount(assetMint, stranger.publicKey, 100n);

    await expectAnchorError(
      doDeposit(v, assetMint, stranger, strangerAccount, 50n),
      "Unauthorized",
    );
  });

  it("withdraw by the authorized key", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);

    const recipient = Keypair.generate().publicKey;
    const destination = await createAccount(
      connection,
      funder,
      assetMint,
      recipient,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    await doWithdraw(v, assetMint, v.withdrawAuthority, destination, 150n);

    const custody = custodyPda(v.vessel, assetMint);
    assert.strictEqual(await tokenBalance(destination), 150n);
    assert.strictEqual(await tokenBalance(custody), 250n);
    const holding: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holding.amount.toString()), 250n);
    assert.strictEqual(BigInt(holding.amount.toString()), await tokenBalance(custody));
  });

  it("rejects withdrawals from an unauthorized key", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);

    const stranger = Keypair.generate();
    const destination = await fundTokenAccount(assetMint, stranger.publicKey, 0n);
    await expectAnchorError(
      doWithdraw(v, assetMint, stranger, destination, 10n),
      "Unauthorized",
    );
  });

  it("rejects over-withdrawal", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);

    const destination = await fundTokenAccount(
      assetMint,
      Keypair.generate().publicKey,
      0n,
    );
    await expectAnchorError(
      doWithdraw(v, assetMint, v.withdrawAuthority, destination, 401n),
      "InsufficientHoldings",
    );
  });

  it("a second asset mint increments asset_count", async () => {
    const v = await initVessel();
    const mintA = await makeAssetMint();
    const mintB = await makeAssetMint();
    const accountA = await fundTokenAccount(mintA, v.depositAuthority.publicKey, 1_000n);
    const accountB = await fundTokenAccount(mintB, v.depositAuthority.publicKey, 2_000n);

    await doDeposit(v, mintA, v.depositAuthority, accountA, 400n);
    await doDeposit(v, mintB, v.depositAuthority, accountB, 700n);

    const config: any = await fetchVessel(v.vessel);
    assert.strictEqual(BigInt(config.assetCount.toString()), 2n);
    const holdingA: any = await fetchHolding(holdingPda(v.vessel, mintA));
    const holdingB: any = await fetchHolding(holdingPda(v.vessel, mintB));
    assert.strictEqual(BigInt(holdingA.amount.toString()), 400n);
    assert.strictEqual(BigInt(holdingB.amount.toString()), 700n);
    assert.strictEqual(await tokenBalance(custodyPda(v.vessel, mintA)), 400n);
    assert.strictEqual(await tokenBalance(custodyPda(v.vessel, mintB)), 700n);
  });

  it("container ownership transfer: new owner recorded, old owner locked out, holdings intact", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);

    const newOwner = Keypair.generate();
    await program.methods
      .transferContainer(newOwner.publicKey)
      .accounts({
        currentOwner: funder.publicKey,
        vessel: v.vessel,
        containerMint: v.containerMint,
      })
      .signers([funder])
      .rpc();

    const config: any = await fetchVessel(v.vessel);
    assert.strictEqual(config.currentOwner.toBase58(), newOwner.publicKey.toBase58());

    // Holdings are untouched by the transfer.
    const holding: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holding.amount.toString()), 400n);
    assert.strictEqual(await tokenBalance(custodyPda(v.vessel, assetMint)), 400n);

    // The old owner can no longer transfer.
    const anotherOwner = Keypair.generate();
    await expectAnchorError(
      program.methods
        .transferContainer(anotherOwner.publicKey)
        .accounts({
          currentOwner: funder.publicKey,
          vessel: v.vessel,
          containerMint: v.containerMint,
        })
        .signers([funder])
        .rpc(),
      "Unauthorized",
    );

    // The new owner cannot deposit or withdraw from the transfer alone:
    // the authority roles were not rotated.
    const newOwnerAccount = await fundTokenAccount(assetMint, newOwner.publicKey, 100n);
    await expectAnchorError(
      doDeposit(v, assetMint, newOwner, newOwnerAccount, 10n),
      "Unauthorized",
    );
    // The recorded authorities still work under the new owner.
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 50n);
    const holdingAfter: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holdingAfter.amount.toString()), 450n);
  });

  it("rejects zero amounts on deposit and withdraw", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await expectAnchorError(
      doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 0n),
      "ZeroAmount",
    );

    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 100n);
    const destination = await fundTokenAccount(assetMint, Keypair.generate().publicKey, 0n);
    await expectAnchorError(
      doWithdraw(v, assetMint, v.withdrawAuthority, destination, 0n),
      "ZeroAmount",
    );
  });

  it("rejects wrong-mint and foreign token accounts on deposit", async () => {
    const v = await initVessel();
    const mintA = await makeAssetMint();
    const mintB = await makeAssetMint();

    // Token account for mint B passed while depositing mint A.
    const accountB = await fundTokenAccount(mintB, v.depositAuthority.publicKey, 500n);
    await expectAnchorError(
      doDeposit(v, mintA, v.depositAuthority, accountB, 10n),
      "InvalidDepositorTokenAccount",
    );

    // Token account for the right mint but owned by someone else.
    const stranger = Keypair.generate();
    const strangerAccount = await fundTokenAccount(mintA, stranger.publicKey, 500n);
    await expectAnchorError(
      doDeposit(v, mintA, v.depositAuthority, strangerAccount, 10n),
      "InvalidDepositorTokenAccount",
    );
  });

  it("keeps a zero-balance holding record instead of closing it", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);

    const destination = await fundTokenAccount(assetMint, Keypair.generate().publicKey, 0n);
    await doWithdraw(v, assetMint, v.withdrawAuthority, destination, 400n);

    const holding: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holding.amount.toString()), 0n);
    assert.strictEqual(await tokenBalance(custodyPda(v.vessel, assetMint)), 0n);
    const config: any = await fetchVessel(v.vessel);
    assert.strictEqual(BigInt(config.assetCount.toString()), 1n);
  });

  it("rejects container transfer by a non-owner", async () => {
    const v = await initVessel();
    const stranger = Keypair.generate();
    await expectAnchorError(
      program.methods
        .transferContainer(Keypair.generate().publicKey)
        .accounts({
          currentOwner: stranger.publicKey,
          vessel: v.vessel,
          containerMint: v.containerMint,
        })
        .signers([stranger])
        .rpc(),
      "Unauthorized",
    );
  });

  it("rejects asset mints with hostile extensions (permanent delegate)", async () => {
    const v = await initVessel();
    // A permanent delegate could drain the custody PDA at will, so the
    // vessel refuses to custody such mints (internal review 2026-09-27).
    const hostileMint = await createMintWithPermanentDelegate();
    const depositorAccount = await fundTokenAccount(
      hostileMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await expectAnchorError(
      doDeposit(v, hostileMint, v.depositAuthority, depositorAccount, 100n),
      "InvalidAssetMint",
    );
    // The failed deposit left no state behind: the holding PDA was never created.
    let holdingExists = true;
    try {
      await fetchHolding(holdingPda(v.vessel, hostileMint));
    } catch {
      holdingExists = false;
    }
    assert.strictEqual(holdingExists, false, "holding PDA must not exist after rejected deposit");
  });

  it("adopt_stray_assets recovers from a direct-transfer desync (griefing)", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 400n);
    const custody = custodyPda(v.vessel, assetMint);

    // Griefing: anyone can send tokens straight to the custody PDA,
    // bypassing the program and desynchronizing the ledger.
    const griefer = Keypair.generate();
    const grieferAccount = await fundTokenAccount(assetMint, griefer.publicKey, 100n);
    await transferChecked(
      connection,
      funder,
      grieferAccount,
      assetMint,
      custody,
      griefer,
      50n,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    assert.strictEqual(await tokenBalance(custody), 450n);

    // The invariant now bricks every deposit and withdrawal for the asset.
    await expectAnchorError(
      doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 10n),
      "HoldingMismatch",
    );
    const destination = await fundTokenAccount(assetMint, Keypair.generate().publicKey, 0n);
    await expectAnchorError(
      doWithdraw(v, assetMint, v.withdrawAuthority, destination, 10n),
      "HoldingMismatch",
    );

    const adoptAccounts = {
      vessel: v.vessel,
      containerMint: v.containerMint,
      assetMint,
      holding: holdingPda(v.vessel, assetMint),
      custodyAccount: custody,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    };
    const doAdopt = (authority: Keypair) =>
      program.methods
        .adoptStrayAssets()
        .accounts({ authority: authority.publicKey, ...adoptAccounts })
        .signers([authority])
        .rpc();

    // A stranger cannot adopt; either vessel authority can.
    const stranger = Keypair.generate();
    const strangerSig = await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(strangerSig);
    await expectAnchorError(doAdopt(stranger), "Unauthorized");
    await doAdopt(v.withdrawAuthority);

    // The stray 50 is credited to the ledger; flows work again.
    const holding: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holding.amount.toString()), 450n);
    await doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 50n);
    assert.strictEqual(await tokenBalance(custody), 500n);
    await doWithdraw(v, assetMint, v.withdrawAuthority, destination, 500n);
    assert.strictEqual(await tokenBalance(destination), 500n);

    // Adopting with no stray balance is a harmless no-op.
    await doAdopt(v.depositAuthority);
    const holdingAfter: any = await fetchHolding(holdingPda(v.vessel, assetMint));
    assert.strictEqual(BigInt(holdingAfter.amount.toString()), 0n);
  });

  it("owner can rotate deposit/withdraw authorities; old keys locked out", async () => {
    const v = await initVessel();
    const assetMint = await makeAssetMint();
    const depositorAccount = await fundTokenAccount(
      assetMint,
      v.depositAuthority.publicKey,
      1_000n,
    );

    const newDepositor = Keypair.generate();
    const newWithdrawer = Keypair.generate();
    for (const kp of [newDepositor, newWithdrawer]) {
      const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }
    const rotateAccounts = {
      currentOwner: funder.publicKey,
      vessel: v.vessel,
      containerMint: v.containerMint,
    };

    // Non-owner cannot rotate.
    const stranger = Keypair.generate();
    await expectAnchorError(
      program.methods
        .updateDepositAuthority(newDepositor.publicKey)
        .accounts({
          currentOwner: stranger.publicKey,
          vessel: v.vessel,
          containerMint: v.containerMint,
        })
        .signers([stranger])
        .rpc(),
      "Unauthorized",
    );
    // The default pubkey is rejected: the role cannot be renounced by accident.
    await expectAnchorError(
      program.methods
        .updateDepositAuthority(PublicKey.default)
        .accounts(rotateAccounts)
        .signers([funder])
        .rpc(),
      "InvalidPubkey",
    );
    await expectAnchorError(
      program.methods
        .updateWithdrawAuthority(PublicKey.default)
        .accounts(rotateAccounts)
        .signers([funder])
        .rpc(),
      "InvalidPubkey",
    );

    await program.methods
      .updateDepositAuthority(newDepositor.publicKey)
      .accounts(rotateAccounts)
      .signers([funder])
      .rpc();
    await program.methods
      .updateWithdrawAuthority(newWithdrawer.publicKey)
      .accounts(rotateAccounts)
      .signers([funder])
      .rpc();
    const config: any = await fetchVessel(v.vessel);
    assert.strictEqual(config.depositAuthority.toBase58(), newDepositor.publicKey.toBase58());
    assert.strictEqual(config.withdrawAuthority.toBase58(), newWithdrawer.publicKey.toBase58());

    // Old deposit authority is locked out; the new one works.
    await expectAnchorError(
      doDeposit(v, assetMint, v.depositAuthority, depositorAccount, 10n),
      "Unauthorized",
    );
    const newDepositorAccount = await fundTokenAccount(assetMint, newDepositor.publicKey, 500n);
    await doDeposit(v, assetMint, newDepositor, newDepositorAccount, 200n);

    // Old withdraw authority is locked out; the new one works.
    const destination = await fundTokenAccount(assetMint, Keypair.generate().publicKey, 0n);
    await expectAnchorError(
      doWithdraw(v, assetMint, v.withdrawAuthority, destination, 10n),
      "Unauthorized",
    );
    await doWithdraw(v, assetMint, newWithdrawer, destination, 200n);
    assert.strictEqual(await tokenBalance(destination), 200n);
  });
});
