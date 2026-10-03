/**
 * Anchor tests for alchemy_vault (Stage 3).
 *
 * Covers the ERC-4626-style share vault: mock MOCK-GOLD collateral mint
 * (Token-2022, metadata-only extensions), vault init with the collateral
 * extension allow-list, 1:1 first deposit, pro-rata deposit/redeem math with
 * fee ceil and withdrawal-limit floor, the solvency invariant, read-only
 * proof snapshots, authority rotation, and adversarial cases (transfer-fee
 * collateral mint rejected, non-authority admin rejected, over-redeem
 * rejected).
 *
 * NOTE on "dust": with the public instruction set the bookkeeping ratio
 * total_collateral/total_shares stays exactly 1:1 from genesis (first
 * deposit is 1:1; every redeem removes gross == shares when the ratio is 1),
 * so floor(amount * total_shares / total_collateral) == amount for every
 * reachable deposit and the dust branch (shares floored to zero) is not
 * reachable on-chain. It exists as defense-in-depth mirroring sdk/src/vault.ts,
 * which tests it with synthetic skewed states. The on-chain ZeroAmount path
 * is covered by the zero-amount tests below.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createAccount,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMint,
  getMintLen,
  getTokenMetadata,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { assert } from "chai";
import { createHash } from "crypto";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("alchemy_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyVault as Program;
  const connection = provider.connection;

  let funder: Keypair;

  before(async () => {
    funder = Keypair.generate();
    const sig = await connection.requestAirdrop(funder.publicKey, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  });

  const bn = (v: bigint | number) => new anchor.BN(v.toString());

  const pda = (seeds: Buffer[], programId: PublicKey) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  const vaultPda = (collateralMint: PublicKey) =>
    pda([Buffer.from("vault"), collateralMint.toBuffer()], program.programId);
  const shareMintPda = (vault: PublicKey) =>
    pda([Buffer.from("vault-shares"), vault.toBuffer()], program.programId);
  const vaultCollateralPda = (vault: PublicKey) =>
    pda([Buffer.from("vault-collateral"), vault.toBuffer()], program.programId);
  const proofPda = (vault: PublicKey) =>
    pda([Buffer.from("vault-proof"), vault.toBuffer()], program.programId);

  async function sendTx(ixs: TransactionInstruction[], signers: Keypair[]): Promise<void> {
    const tx = new Transaction().add(...ixs);
    const sig = await connection.sendTransaction(tx, signers, { skipPreflight: false });
    await connection.confirmTransaction(sig);
  }

  async function airdropTo(pubkey: PublicKey, sol: number = 2): Promise<void> {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }

  /**
   * MOCK-GOLD: a Token-2022 mint carrying ONLY MetadataPointer +
   * TokenMetadata (the allow-listed "metadata-only" shape). Unmistakably
   * labeled; never "PAXG".
   */
  async function makeMockGoldMint(): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const name = "MOCK-GOLD";
    const symbol = "MOCK";
    const uri = "";
    // Borsh-packed TokenMetadata for the values above:
    // 32 (update authority) + 32 (mint) + (4+9) name + (4+4) symbol +
    // (4+0) uri + 4 (empty additional_metadata vec).
    const metadataValueLen = 32 + 32 + (4 + name.length) + (4 + symbol.length) + (4 + uri.length) + 4;
    // Allocate ONLY the MetadataPointer space, but fund rent for the full
    // layout. Pre-allocating the TokenMetadata region leaves zeros after the
    // MetadataPointer TLV entry, and InitializeMint2's TLV parser rejects
    // them (InvalidAccountData). The token-metadata initialize instruction
    // reallocates the account from 234 to the full size itself.
    const space = getMintLen([ExtensionType.MetadataPointer]);
    const lamports = await connection.getMinimumBalanceForRentExemption(
      getMintLen([ExtensionType.MetadataPointer], {
        [ExtensionType.TokenMetadata]: metadataValueLen,
      }),
    );

    // Raw token-metadata `initialize` instruction (discriminator =
    // sha256("spl_token_metadata_interface:initialize_account")[0..8]).
    const discriminator = createHash("sha256")
      .update("spl_token_metadata_interface:initialize_account")
      .digest()
      .subarray(0, 8);
    const encStr = (s: string): Buffer => {
      const b = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length, 0);
      return Buffer.concat([len, b]);
    };
    const initMetadataIx = new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: true }, // metadata (in the mint)
        { pubkey: funder.publicKey, isSigner: false, isWritable: false }, // update authority
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: false }, // mint
        { pubkey: funder.publicKey, isSigner: true, isWritable: false }, // mint authority
      ],
      data: Buffer.concat([discriminator, encStr(name), encStr(symbol), encStr(uri)]),
    });

    await sendTx(
      [
        SystemProgram.createAccount({
          fromPubkey: funder.publicKey,
          newAccountPubkey: mintKp.publicKey,
          lamports,
          space,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMetadataPointerInstruction(
          mintKp.publicKey,
          funder.publicKey,
          mintKp.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMint2Instruction(
          mintKp.publicKey,
          6,
          funder.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID,
        ),
        initMetadataIx,
      ],
      [funder, mintKp],
    );
    return mintKp.publicKey;
  }

  /** A Token-2022 mint with a TransferFeeConfig extension (NOT allow-listed). */
  async function makeTransferFeeMint(): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const space = getMintLen([ExtensionType.TransferFeeConfig]);
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    await sendTx(
      [
        SystemProgram.createAccount({
          fromPubkey: funder.publicKey,
          newAccountPubkey: mintKp.publicKey,
          lamports,
          space,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferFeeConfigInstruction(
          mintKp.publicKey,
          funder.publicKey,
          funder.publicKey,
          100, // 1%
          BigInt(1_000_000),
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMint2Instruction(
          mintKp.publicKey,
          6,
          funder.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID,
        ),
      ],
      [funder, mintKp],
    );
    return mintKp.publicKey;
  }

  interface VaultFixture {
    collateralMint: PublicKey;
    vault: PublicKey;
    shareMint: PublicKey;
    vaultCollateral: PublicKey;
  }

  async function initVault(opts?: {
    collateralMint?: PublicKey;
    withdrawalLimitBps?: number;
    redeemFeeBps?: number;
    isMock?: boolean;
    mockLabel?: string;
    authority?: Keypair;
  }): Promise<VaultFixture> {
    const collateralMint = opts?.collateralMint ?? (await makeMockGoldMint());
    const authority = opts?.authority ?? funder;
    const vault = vaultPda(collateralMint);
    const shareMint = shareMintPda(vault);
    const vaultCollateral = vaultCollateralPda(vault);
    await program.methods
      .initializeVault(
        collateralMint,
        opts?.withdrawalLimitBps ?? 10000,
        opts?.redeemFeeBps ?? 0,
        opts?.isMock ?? true,
        opts?.mockLabel ?? "MOCK-GOLD — NOT PAXG, NO VALUE",
      )
      .accounts({
        authority: authority.publicKey,
        vaultConfig: vault,
        collateralMint,
        shareMint,
        vaultCollateralAccount: vaultCollateral,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();
    return { collateralMint, vault, shareMint, vaultCollateral };
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
      new Keypair(),
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    if (amount > 0n) {
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
    }
    return acct;
  }

  async function newDepositor(): Promise<Keypair> {
    const kp = Keypair.generate();
    await airdropTo(kp.publicKey);
    return kp;
  }

  async function doDeposit(
    v: VaultFixture,
    depositor: Keypair,
    depositorAccount: PublicKey,
    amount: bigint,
  ): Promise<PublicKey> {
    const depositorShares = getAssociatedTokenAddressSync(
      v.shareMint,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await program.methods
      .depositCollateral(bn(amount))
      .accounts({
        depositor: depositor.publicKey,
        vaultConfig: v.vault,
        collateralMint: v.collateralMint,
        depositorCollateralAccount: depositorAccount,
        vaultCollateralAccount: v.vaultCollateral,
        shareMint: v.shareMint,
        depositorShareAccount: depositorShares,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();
    return depositorShares;
  }

  async function doRedeem(
    v: VaultFixture,
    redeemer: Keypair,
    shares: bigint,
    redeemerCollateralAccount: PublicKey,
    treasury: PublicKey,
  ): Promise<void> {
    const redeemerShares = getAssociatedTokenAddressSync(
      v.shareMint,
      redeemer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await program.methods
      .redeemShares(bn(shares))
      .accounts({
        redeemer: redeemer.publicKey,
        vaultConfig: v.vault,
        collateralMint: v.collateralMint,
        redeemerShareAccount: redeemerShares,
        shareMint: v.shareMint,
        vaultCollateralAccount: v.vaultCollateral,
        redeemerCollateralAccount,
        treasury,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([redeemer])
      .rpc();
  }

  async function doPublishProof(v: VaultFixture, publisher: Keypair): Promise<PublicKey> {
    const proof = proofPda(v.vault);
    await program.methods
      .publishProof()
      .accounts({
        publisher: publisher.publicKey,
        vaultConfig: v.vault,
        proof,
        vaultCollateralAccount: v.vaultCollateral,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers([publisher])
      .rpc();
    return proof;
  }

  const tokenBalance = async (account: PublicKey): Promise<bigint> => {
    const acc = await getAccount(connection, account, undefined, TOKEN_2022_PROGRAM_ID);
    return acc.amount;
  };

  // Cast through `any`: without generated IDL types the account namespace
  // is untyped (same reason vessel.ts needs its `: any` casts).
  const fetchConfig = async (vault: PublicKey): Promise<any> =>
    (program.account as any).vaultConfig.fetch(vault);

  const fetchProof = async (proof: PublicKey): Promise<any> =>
    (program.account as any).vaultProof.fetch(proof);

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

  it("initializes the vault: PDAs, metadata-only share mint, config fields", async () => {
    const v = await initVault({ withdrawalLimitBps: 7500, redeemFeeBps: 250 });

    const config: any = await fetchConfig(v.vault);
    assert.strictEqual(config.collateralMint.toBase58(), v.collateralMint.toBase58());
    assert.strictEqual(config.shareMint.toBase58(), v.shareMint.toBase58());
    assert.strictEqual(config.authority.toBase58(), funder.publicKey.toBase58());
    // Fee recipient defaults to the initializing authority.
    assert.strictEqual(config.treasury.toBase58(), funder.publicKey.toBase58());
    assert.strictEqual(BigInt(config.totalCollateral.toString()), 0n);
    assert.strictEqual(BigInt(config.totalShares.toString()), 0n);
    assert.strictEqual(config.withdrawalLimitBps, 7500);
    assert.strictEqual(config.redeemFeeBps, 250);
    assert.strictEqual(config.isMockCollateral, true);
    assert.strictEqual(config.mockLabel, "MOCK-GOLD — NOT PAXG, NO VALUE");

    // Share mint: Token-2022, metadata-only extensions, vault PDA is the
    // mint authority, no freeze authority, decimals mirror the collateral.
    const shareInfo = await getMint(connection, v.shareMint, undefined, TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(shareInfo.decimals, 6);
    assert.strictEqual(shareInfo.mintAuthority?.toBase58(), v.vault.toBase58());
    assert.strictEqual(shareInfo.freezeAuthority, null);
    const shareExts = getExtensionTypes(shareInfo.tlvData);
    assert.strictEqual(shareExts.length, 2);
    assert.isTrue(shareExts.includes(ExtensionType.MetadataPointer));
    assert.isTrue(shareExts.includes(ExtensionType.TokenMetadata));
    // Unmistakable mock labeling on the share mint itself.
    const shareMeta = await getTokenMetadata(connection, v.shareMint, undefined, TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(shareMeta?.name, "Alchemy Vault Share (MOCK)");
    assert.strictEqual(shareMeta?.symbol, "AVS-MOCK");

    // Vault collateral account: Token-2022, PDA-owned by the vault, empty.
    const vaultAcct = await getAccount(connection, v.vaultCollateral, undefined, TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(vaultAcct.owner.toBase58(), v.vault.toBase58());
    assert.strictEqual(vaultAcct.mint.toBase58(), v.collateralMint.toBase58());
    assert.strictEqual(vaultAcct.amount, 0n);
  });

  it("rejects invalid bps and bad mock labels at init", async () => {
    const collateralMint = await makeMockGoldMint();
    const init = (limitBps: number, feeBps: number, isMock: boolean, label: string) =>
      initVault({ collateralMint, withdrawalLimitBps: limitBps, redeemFeeBps: feeBps, isMock, mockLabel: label });

    await expectAnchorError(init(10001, 0, true, "MOCK-GOLD"), "InvalidBps");
    await expectAnchorError(init(10000, 10001, true, "MOCK-GOLD"), "InvalidBps");
    await expectAnchorError(init(10000, 0, true, ""), "InvalidMockLabel");
    await expectAnchorError(init(10000, 0, true, "x".repeat(65)), "InvalidMockLabel");
    // A vault declaring real collateral must not carry a mock label.
    await expectAnchorError(init(10000, 0, false, "MOCK-GOLD"), "InvalidMockLabel");
  });

  it("rejects a collateral mint carrying a non-allow-listed extension", async () => {
    const feeMint = await makeTransferFeeMint();
    // Sanity: the fixture really does carry TransferFeeConfig.
    const mintInfo = await getMint(connection, feeMint, undefined, TOKEN_2022_PROGRAM_ID);
    assert.isTrue(getExtensionTypes(mintInfo.tlvData).includes(ExtensionType.TransferFeeConfig));

    await expectAnchorError(initVault({ collateralMint: feeMint }), "InvalidCollateralMint");
  });

  it("rejects init when the collateral mint arg disagrees with the account", async () => {
    const collateralMint = await makeMockGoldMint();
    const otherMint = await makeMockGoldMint();
    const vault = vaultPda(collateralMint);
    await expectAnchorError(
      program.methods
        .initializeVault(otherMint, 10000, 0, true, "MOCK-GOLD")
        .accounts({
          authority: funder.publicKey,
          vaultConfig: vault,
          collateralMint,
          shareMint: shareMintPda(vault),
          vaultCollateralAccount: vaultCollateralPda(vault),
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([funder])
        .rpc(),
      "InvalidCollateralMint",
    );
  });

  it("first deposit mints shares 1:1; later deposits are pro-rata", async () => {
    const v = await initVault();
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 2_000_000n);

    const sharesAccount = await doDeposit(v, depositor, depositorAccount, 1_000_000n);
    assert.strictEqual(await tokenBalance(sharesAccount), 1_000_000n);
    assert.strictEqual(await tokenBalance(depositorAccount), 1_000_000n);
    assert.strictEqual(await tokenBalance(v.vaultCollateral), 1_000_000n);
    let config: any = await fetchConfig(v.vault);
    assert.strictEqual(BigInt(config.totalCollateral.toString()), 1_000_000n);
    assert.strictEqual(BigInt(config.totalShares.toString()), 1_000_000n);

    // Second deposit at the same 1:1 bookkeeping ratio mints the same amount.
    await doDeposit(v, depositor, depositorAccount, 500_000n);
    assert.strictEqual(await tokenBalance(sharesAccount), 1_500_000n);
    config = await fetchConfig(v.vault);
    assert.strictEqual(BigInt(config.totalCollateral.toString()), 1_500_000n);
    assert.strictEqual(BigInt(config.totalShares.toString()), 1_500_000n);
    assert.strictEqual(await tokenBalance(v.vaultCollateral), 1_500_000n);
  });

  it("rejects zero-amount deposits", async () => {
    const v = await initVault();
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 100n);
    await expectAnchorError(
      doDeposit(v, depositor, depositorAccount, 0n),
      "ZeroAmount",
    );
  });

  it("rejects deposits of the wrong mint", async () => {
    const v = await initVault();
    const otherMint = await makeMockGoldMint();
    const depositor = await newDepositor();
    const wrongAccount = await fundTokenAccount(otherMint, depositor.publicKey, 100n);
    await expectAnchorError(
      doDeposit(v, depositor, wrongAccount, 10n),
      "InvalidCollateralMint",
    );
  });

  it("redeems with fee math: gross floors, fee ceils, burn + payouts", async () => {
    // 1% redeem fee, no withdrawal limit.
    const v = await initVault({ redeemFeeBps: 100, withdrawalLimitBps: 10000 });
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 1_000_000n);
    await doDeposit(v, depositor, depositorAccount, 1_000_000n);

    const treasury = await fundTokenAccount(v.collateralMint, funder.publicKey, 0n);
    const redeemerCollateral = await fundTokenAccount(v.collateralMint, depositor.publicKey, 0n);

    // gross = floor(400000 * 1000000 / 1000000) = 400000;
    // fee = ceil(400000 * 100 / 10000) = 4000; net = 396000.
    await doRedeem(v, depositor, 400_000n, redeemerCollateral, treasury);
    assert.strictEqual(await tokenBalance(redeemerCollateral), 396_000n);
    assert.strictEqual(await tokenBalance(treasury), 4_000n);
    const sharesAccount = getAssociatedTokenAddressSync(
      v.shareMint, depositor.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    assert.strictEqual(await tokenBalance(sharesAccount), 600_000n);
    const config: any = await fetchConfig(v.vault);
    assert.strictEqual(BigInt(config.totalCollateral.toString()), 600_000n);
    assert.strictEqual(BigInt(config.totalShares.toString()), 600_000n);
    assert.strictEqual(await tokenBalance(v.vaultCollateral), 600_000n);

    // Non-exact fee: gross = 333, fee = ceil(333 * 100 / 10000) = ceil(3.33) = 4, net = 329.
    await doRedeem(v, depositor, 333n, redeemerCollateral, treasury);
    assert.strictEqual(await tokenBalance(redeemerCollateral), 396_000n + 329n);
    assert.strictEqual(await tokenBalance(treasury), 4_000n + 4n);
  });

  it("withdrawal limit boundary: gross == limit passes, limit + 1 fails", async () => {
    const v = await initVault({ withdrawalLimitBps: 5000, redeemFeeBps: 0 });
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 2_000_000n);
    await doDeposit(v, depositor, depositorAccount, 2_000_000n);
    const treasury = await fundTokenAccount(v.collateralMint, funder.publicKey, 0n);
    const redeemerCollateral = await fundTokenAccount(v.collateralMint, depositor.publicKey, 0n);

    // gross = 1_000_000; limit = floor(2_000_000 * 5000 / 10000) = 1_000_000 -> passes.
    await doRedeem(v, depositor, 1_000_000n, redeemerCollateral, treasury);
    assert.strictEqual(await tokenBalance(redeemerCollateral), 1_000_000n);

    // Now totals are 1M/1M: gross = 500_001 > limit = floor(1M * 5000/10000) = 500_000 -> fails.
    await expectAnchorError(
      doRedeem(v, depositor, 500_001n, redeemerCollateral, treasury),
      "WithdrawalLimitExceeded",
    );
    // Exactly at the new limit still passes.
    await doRedeem(v, depositor, 500_000n, redeemerCollateral, treasury);
    assert.strictEqual(await tokenBalance(redeemerCollateral), 1_500_000n);
  });

  it("rejects redeeming more shares than exist and zero-share redeems", async () => {
    const v = await initVault();
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 1_000n);
    await doDeposit(v, depositor, depositorAccount, 1_000n);
    const treasury = await fundTokenAccount(v.collateralMint, funder.publicKey, 0n);
    const redeemerCollateral = await fundTokenAccount(v.collateralMint, depositor.publicKey, 0n);

    // Sole holder owns all 1000 shares; 1001 exceeds total_shares.
    await expectAnchorError(
      doRedeem(v, depositor, 1001n, redeemerCollateral, treasury),
      "InsufficientShares",
    );
    await expectAnchorError(
      doRedeem(v, depositor, 0n, redeemerCollateral, treasury),
      "ZeroAmount",
    );
  });

  it("rejects redeeming to a treasury account owned by someone else", async () => {
    const v = await initVault();
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 1_000n);
    await doDeposit(v, depositor, depositorAccount, 1_000n);
    const redeemerCollateral = await fundTokenAccount(v.collateralMint, depositor.publicKey, 0n);
    // Treasury token account owned by a stranger, not the recorded treasury (funder).
    const strangerTreasury = await fundTokenAccount(v.collateralMint, Keypair.generate().publicKey, 0n);
    await expectAnchorError(
      doRedeem(v, depositor, 100n, redeemerCollateral, strangerTreasury),
      "InvalidTreasuryAccount",
    );
  });

  it("authority rotation: non-authority fails, authority succeeds", async () => {
    const v = await initVault();
    const stranger = Keypair.generate();
    await airdropTo(stranger.publicKey);

    await expectAnchorError(
      program.methods
        .updateVaultAuthority(stranger.publicKey)
        .accounts({ authority: stranger.publicKey, vaultConfig: v.vault })
        .signers([stranger])
        .rpc(),
      "Unauthorized",
    );

    const newAuthority = Keypair.generate();
    await program.methods
      .updateVaultAuthority(newAuthority.publicKey)
      .accounts({ authority: funder.publicKey, vaultConfig: v.vault })
      .signers([funder])
      .rpc();
    let config: any = await fetchConfig(v.vault);
    assert.strictEqual(config.authority.toBase58(), newAuthority.publicKey.toBase58());

    // The old authority is now locked out.
    const another = Keypair.generate();
    await expectAnchorError(
      program.methods
        .updateVaultAuthority(another.publicKey)
        .accounts({ authority: funder.publicKey, vaultConfig: v.vault })
        .signers([funder])
        .rpc(),
      "Unauthorized",
    );

    // The default pubkey is never a valid authority.
    await airdropTo(newAuthority.publicKey);
    await expectAnchorError(
      program.methods
        .updateVaultAuthority(PublicKey.default)
        .accounts({ authority: newAuthority.publicKey, vaultConfig: v.vault })
        .signers([newAuthority])
        .rpc(),
      "InvalidPubkey",
    );
    config = await fetchConfig(v.vault);
    assert.strictEqual(config.authority.toBase58(), newAuthority.publicKey.toBase58());
  });

  it("treasury rotation: non-authority fails, authority redirects fees", async () => {
    // Without a rotation path, fee flow would be permanently bound to the
    // initializing key: a lost treasury key would strand all future fees.
    const v = await initVault({ redeemFeeBps: 100, withdrawalLimitBps: 10000 });
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 1_000_000n);
    await doDeposit(v, depositor, depositorAccount, 1_000_000n);

    const newTreasury = Keypair.generate();
    const newTreasuryAccount = await fundTokenAccount(v.collateralMint, newTreasury.publicKey, 0n);
    const oldTreasuryAccount = await fundTokenAccount(v.collateralMint, funder.publicKey, 0n);
    const redeemerCollateral = await fundTokenAccount(v.collateralMint, depositor.publicKey, 0n);

    // Non-authority cannot rotate the treasury.
    const stranger = await newDepositor();
    await expectAnchorError(
      program.methods
        .updateVaultTreasury(newTreasury.publicKey)
        .accounts({ authority: stranger.publicKey, vaultConfig: v.vault })
        .signers([stranger])
        .rpc(),
      "Unauthorized",
    );

    // The all-zero address is never a valid treasury.
    await expectAnchorError(
      program.methods
        .updateVaultTreasury(PublicKey.default)
        .accounts({ authority: funder.publicKey, vaultConfig: v.vault })
        .signers([funder])
        .rpc(),
      "InvalidPubkey",
    );

    // Authority rotates the treasury.
    await program.methods
      .updateVaultTreasury(newTreasury.publicKey)
      .accounts({ authority: funder.publicKey, vaultConfig: v.vault })
      .signers([funder])
      .rpc();
    let config: any = await fetchConfig(v.vault);
    assert.strictEqual(config.treasury.toBase58(), newTreasury.publicKey.toBase58());

    // Fees now flow to the new treasury: redeem 400_000 shares ->
    // gross = 400_000, fee = ceil(400_000 * 100 / 10_000) = 4_000, net = 396_000.
    await doRedeem(v, depositor, 400_000n, redeemerCollateral, newTreasuryAccount);
    assert.strictEqual(await tokenBalance(newTreasuryAccount), 4_000n);
    assert.strictEqual(await tokenBalance(redeemerCollateral), 396_000n);

    // The old treasury account is no longer accepted as the fee recipient.
    await expectAnchorError(
      doRedeem(v, depositor, 100n, redeemerCollateral, oldTreasuryAccount),
      "InvalidTreasuryAccount",
    );
    config = await fetchConfig(v.vault);
    assert.strictEqual(config.treasury.toBase58(), newTreasury.publicKey.toBase58());
  });

  it("publish_proof: anyone can publish; fields match on-chain state", async () => {
    const v = await initVault();
    const depositor = await newDepositor();
    // Fund 1.5M: 1M is deposited; the remaining 500K funds the later
    // direct-donation step below.
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 1_500_000n);
    await doDeposit(v, depositor, depositorAccount, 1_000_000n);

    const publisher = await newDepositor();
    const proof = await doPublishProof(v, publisher);
    let snapshot: any = await fetchProof(proof);
    assert.strictEqual(snapshot.vault.toBase58(), v.vault.toBase58());
    assert.strictEqual(BigInt(snapshot.totalCollateral.toString()), 1_000_000n);
    assert.strictEqual(BigInt(snapshot.outstandingClaims.toString()), 1_000_000n);
    // ratio = floor(1_000_000 * 10000 / 1_000_000) = 10000 bps.
    assert.strictEqual(BigInt(snapshot.collateralRatioBps.toString()), 10_000n);
    assert.strictEqual(snapshot.authority.toBase58(), funder.publicKey.toBase58());
    assert.strictEqual(snapshot.treasury.toBase58(), funder.publicKey.toBase58());
    assert.strictEqual(snapshot.isMockCollateral, true);
    assert.isTrue(BigInt(snapshot.publishedTs.toString()) > 0n);

    // A direct donation raises the actual balance above bookkeeping claims;
    // the proof reflects the surplus honestly.
    await transfer(
      connection,
      funder,
      depositorAccount,
      v.vaultCollateral,
      depositor.publicKey,
      500_000n,
      [depositor],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const proof2 = await doPublishProof(v, publisher);
    snapshot = await fetchProof(proof2);
    assert.strictEqual(BigInt(snapshot.totalCollateral.toString()), 1_500_000n);
    assert.strictEqual(BigInt(snapshot.outstandingClaims.toString()), 1_000_000n);
    // ratio = floor(1_500_000 * 10000 / 1_000_000) = 15000 bps.
    assert.strictEqual(BigInt(snapshot.collateralRatioBps.toString()), 15_000n);
  });

  it("full redeem to zero leaves consistent state; empty vault proof ratio is u64::MAX", async () => {
    const v = await initVault({ redeemFeeBps: 0, withdrawalLimitBps: 10000 });
    const depositor = await newDepositor();
    const depositorAccount = await fundTokenAccount(v.collateralMint, depositor.publicKey, 1_000_000n);
    await doDeposit(v, depositor, depositorAccount, 1_000_000n);
    const treasury = await fundTokenAccount(v.collateralMint, funder.publicKey, 0n);
    const redeemerCollateral = await fundTokenAccount(v.collateralMint, depositor.publicKey, 0n);

    await doRedeem(v, depositor, 1_000_000n, redeemerCollateral, treasury);

    const config: any = await fetchConfig(v.vault);
    assert.strictEqual(BigInt(config.totalCollateral.toString()), 0n);
    assert.strictEqual(BigInt(config.totalShares.toString()), 0n);
    assert.strictEqual(await tokenBalance(v.vaultCollateral), 0n);
    assert.strictEqual(await tokenBalance(redeemerCollateral), 1_000_000n);
    const sharesAccount = getAssociatedTokenAddressSync(
      v.shareMint, depositor.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    assert.strictEqual(await tokenBalance(sharesAccount), 0n);

    const publisher = await newDepositor();
    const proof = await doPublishProof(v, publisher);
    const snapshot: any = await fetchProof(proof);
    assert.strictEqual(BigInt(snapshot.outstandingClaims.toString()), 0n);
    assert.strictEqual(
      BigInt(snapshot.collateralRatioBps.toString()),
      18446744073709551615n, // u64::MAX: no outstanding claims
    );
  });
});
