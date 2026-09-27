/**
 * Anchor tests for alchemy_factory (experiment registry).
 *
 * Covers: registration (PDA derivation, stored fields, disclosure event),
 * per-authority experiment_id namespacing (no cross-authority squatting or
 * overwrites), and authority-rotation rules — only the current authority may
 * rotate, rotating to the default pubkey is rejected (it would brick admin),
 * and the old authority is locked out afterwards.
 *
 * Security-review note: these tests were written as part of our own internal
 * review of the Alchemy Factory programs. They are regression coverage, not
 * an independent security audit.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

describe("alchemy_factory", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyFactory as Program;
  const payer = provider.wallet.publicKey;

  const bn = (v: bigint | number) => new anchor.BN(v.toString());

  before(async () => {
    const sig = await provider.connection.requestAirdrop(payer, 100 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  });

  async function airdrop(pk: PublicKey, sol = 2) {
    const sig = await provider.connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  }

  function experimentPda(authorityPk: PublicKey, experimentId: bigint): PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(experimentId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("experiment"), authorityPk.toBuffer(), idBuf],
      program.programId,
    );
    return pda;
  }

  async function register(
    authorityKp: Keypair | null,
    experimentId: bigint,
    mechanic: any = { timeDecaying: {} },
  ): Promise<PublicKey> {
    const authorityPk = authorityKp ? authorityKp.publicKey : payer;
    const pda = experimentPda(authorityPk, experimentId);
    await program.methods
      .initializeExperiment(
        bn(experimentId),
        mechanic,
        Array(32).fill(11), // config_hash
        Array(32).fill(22), // holder_rights_hash
      )
      .accounts({
        authority: authorityPk,
        experiment: pda,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(authorityKp ? [authorityKp] : [])
      .rpc();
    return pda;
  }

  const fetchExperiment = async (pda: PublicKey): Promise<any> =>
    (program.account as any).experiment.fetch(pda);

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

  /** Subscribe to an event, run `action`, resolve with the first event received. */
  async function captureEvent<T>(
    eventName: string,
    action: () => Promise<unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    let id: number | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for event ${eventName}`)),
          timeoutMs,
        );
        (async () => {
          id = await program.addEventListener(eventName, (event: any) => {
            clearTimeout(timer);
            resolve(event as T);
          });
          try {
            await action();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        })();
      });
    } finally {
      if (id !== undefined) {
        await program.removeEventListener(id).catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------

  it("registers an experiment with the signer as authority", async () => {
    const experimentId = 7n;
    let pda: PublicKey | undefined;
    const event = await captureEvent<any>("experimentRegistered", async () => {
      pda = await register(null, experimentId, { dynamicAndEvolving: {} });
    });

    assert.strictEqual(event.experiment.toBase58(), pda!.toBase58());
    assert.strictEqual(BigInt(event.experimentId.toString()), experimentId);
    assert.strictEqual(event.mechanicTag, 0); // DynamicAndEvolving
    assert.strictEqual(event.authority.toBase58(), payer.toBase58());
    assert.deepStrictEqual(Array.from(event.configHash as number[]), Array(32).fill(11));
    assert.deepStrictEqual(
      Array.from(event.holderRightsHash as number[]),
      Array(32).fill(22),
    );

    const exp = await fetchExperiment(pda!);
    assert.strictEqual(exp.authority.toBase58(), payer.toBase58());
    assert.deepStrictEqual(Array.from(exp.configHash as number[]), Array(32).fill(11));
    assert.deepStrictEqual(
      Array.from(exp.holderRightsHash as number[]),
      Array(32).fill(22),
    );
    assert(BigInt(exp.createdAt.toString()) > 0n, "created_at is stamped");
  });

  it("rejects re-registration of the same (authority, experiment_id): no overwrite", async () => {
    const experimentId = 4242n;
    await register(null, experimentId);
    // A second init for the same PDA must fail — the entry cannot be
    // overwritten or re-registered by anyone, including the authority.
    let failed = false;
    try {
      await register(null, experimentId);
    } catch {
      failed = true;
    }
    assert(failed, "expected re-initialization of the same experiment PDA to fail");
  });

  it("namespaces experiment_id per authority: no cross-authority squatting", async () => {
    const experimentId = 99n;
    const other = Keypair.generate();
    await airdrop(other.publicKey);

    // The same experiment_id under two different authorities yields two
    // distinct PDAs; neither registration interferes with the other.
    const pdaA = await register(null, experimentId);
    const pdaB = await register(other, experimentId);
    assert.notStrictEqual(pdaA.toBase58(), pdaB.toBase58(), "distinct PDAs");

    const expA = await fetchExperiment(pdaA);
    const expB = await fetchExperiment(pdaB);
    assert.strictEqual(expA.authority.toBase58(), payer.toBase58());
    assert.strictEqual(expB.authority.toBase58(), other.publicKey.toBase58());

    // An attacker cannot register "as" someone else: the PDA seeds bind the
    // signer's own key, so victim-keyed PDAs are unreachable without the
    // victim's signature. Attempting to rotate the victim's entry fails.
    const evil = Keypair.generate();
    await airdrop(evil.publicKey);
    const evilRotate = program.methods
      .updateAuthorities(evil.publicKey)
      .accounts({ authority: evil.publicKey, experiment: pdaA })
      .signers([evil])
      .rpc();
    await expectAnchorError(evilRotate, "Unauthorized");
  });

  it("rejects rotating the authority to the default pubkey (anti-bricking)", async () => {
    const pda = await register(null, 1001n);
    const brick = program.methods
      .updateAuthorities(PublicKey.default)
      .accounts({ authority: payer, experiment: pda })
      .rpc();
    await expectAnchorError(brick, "InvalidAuthority");

    // The authority is unchanged after the rejected rotation.
    const exp = await fetchExperiment(pda);
    assert.strictEqual(exp.authority.toBase58(), payer.toBase58());
  });

  it("rotates the authority; the old authority is locked out", async () => {
    const pda = await register(null, 1002n);
    const successor = Keypair.generate();

    const event = await captureEvent<any>("authoritiesUpdated", () =>
      program.methods
        .updateAuthorities(successor.publicKey)
        .accounts({ authority: payer, experiment: pda })
        .rpc(),
    );
    assert.strictEqual(event.experiment.toBase58(), pda.toBase58());
    assert.strictEqual(event.oldAuthority.toBase58(), payer.toBase58());
    assert.strictEqual(event.newAuthority.toBase58(), successor.publicKey.toBase58());

    const exp = await fetchExperiment(pda);
    assert.strictEqual(exp.authority.toBase58(), successor.publicKey.toBase58());

    // The old authority can no longer rotate.
    await airdrop(successor.publicKey);
    const staleRotate = program.methods
      .updateAuthorities(payer)
      .accounts({ authority: payer, experiment: pda })
      .rpc();
    await expectAnchorError(staleRotate, "Unauthorized");

    // The new authority can rotate onwards.
    const next = Keypair.generate();
    await program.methods
      .updateAuthorities(next.publicKey)
      .accounts({ authority: successor.publicKey, experiment: pda })
      .signers([successor])
      .rpc();
    const exp2 = await fetchExperiment(pda);
    assert.strictEqual(exp2.authority.toBase58(), next.publicKey.toBase58());
  });
});
