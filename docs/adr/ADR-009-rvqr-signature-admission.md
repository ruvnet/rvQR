# ADR-009: A Pinned Fingerprint Is Enforced at the Vault Write

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 |
| Scope | Where the signature verdict is applied, and what a pin means |
| Implementation | Shipped. `core.admitArtifact` in `artifacts/core.js`, called from `finishReceive` in `artifacts/app.js` |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-006: QR-Bootstrapped Escalation](./ADR-006-rvqr-p2p-escalation.md), [ADR-007: Ultrasonic Control Channel](./ADR-007-rvqr-ultrasonic-control-channel.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2 states rvQR's position:
integrity without authenticity, said out loud everywhere a user might form an
expectation. Manifest signing and a pinnable fingerprint were the intended
remedy, and they were built.

They did not work, in two ways that are worth recording together because they
share a shape.

**The pin was advisory.** `finishReceive()` verified SHA-256 and stored, and
never consulted the signature verdict at all. `verifyManifestSignature()`
resolved asynchronously alongside it and its result reached only the badge in
the UI. A transfer signed by the wrong key — or by no key — reached the vault
regardless of what the badge said. The UI's own copy for the `wrong-key` state
reads *"A valid signature, but not from the fingerprint you pinned. Treat this
transfer as hostile until you know why"*, printed next to an artifact that had
already been stored.

**Signing never happened.** `artifacts/app.js` called
`signManifest(manifest, key)`; the function takes `(key, manifest)`. The
canonicaliser threw on every send, and a bare `.catch(() => null)` turned that
throw into a silent `unsigned`. Every transfer the app had ever sent with
signing switched on went out unsigned, and nothing anywhere said so.

The common shape is what makes this an architectural decision rather than a
bug report: **a security control that reports rather than enforces is worse
than no control**, because it manufactures the confidence it does not supply. A
badge that says "pinned" changes what a person does next. So does a "signing"
toggle that is on.

## 2. Decision

### 2.1 Admission is a pure function, and storage waits for it

`core.admitArtifact(pin, verification)` decides whether a hash-verified artifact
may be written to the vault. It is pure — a pin and a verdict in, an
`{ admit, code, reason }` out — so the rule can be tested exhaustively without a
camera, a vault or a clock.

| Pin | Verdict | Result |
|---|---|---|
| none | anything | **admit** — `no-pin` |
| set | absent, or present with no `state` | **refuse** — `pending` |
| set | `pinned` | **admit** |
| set | `wrong-key` | refuse — `wrong-key` |
| set | `bad` | refuse — `bad-signature` |
| set | `unsigned` | refuse — `unsigned` |
| set | `signed` | refuse — `unpinned-key` |
| set | anything else | **refuse** — `unknown-verdict` |

Three properties are deliberate:

- **A pending check never admits.** That is the race the function exists to
  close: the verdict resolves asynchronously, so `finishReceive` now awaits it
  before calling in.
- **An unrecognised verdict fails closed.** A future verification state must not
  become an accidental bypass by falling through a `switch`.
- **No pin is unchanged.** The operator has named no signer, so integrity is the
  whole contract and the surrounding UI is responsible for saying so — which it
  does, in the About tab, the welcome, the README and
  [docs/protocol.md](../protocol.md).

The hash check runs first and independently. A hash mismatch still discards the
entire transfer with no partial acceptance
([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2); admission is a second
gate, not a replacement for the first.

### 2.2 A failed signature is reported, never downgraded

`.catch(() => null)` around a signing call converts an error into the feature's
*off* state, which is exactly how defect two hid for as long as it did. Signing
failure is now surfaced, and the transfer continues unsigned rather than
pretending it was never asked.

The general rule: **a catch that maps an error onto a security feature's
disabled state is a defect, not defensive coding.** It is worth looking for the
same pattern elsewhere on the receive path.

### 2.3 Verified in a browser, not only in unit tests

Both defects passed unit tests before the fix, because the tests covered the
verification function and not the path from a verdict to a vault write. The fix
was therefore checked in Chromium as well: with a fingerprint pinned, an
unsigned transfer is refused and the vault stays empty; with no pin, the same
transfer stores as before. 72 of 72 app tests pass, four of which pin the
admission rules above.

### 2.4 The signing key is in plaintext `localStorage`, and that is a
demonstration, not a design

`ensureIdentity()` generates one key pair per browser and writes it to
`localStorage` under `rvqr.identity.v1` as JSON with the secret in hex. The code
says so where it happens: *"This is a demonstration of the mechanism, not a key
management system: anything that can read the page's storage can read this
key."*

That is an acceptable position for a static page whose purpose is to show that
signed optical transfer works. It is not acceptable for anything anyone relies
on, because the key is readable by any script that runs on the origin, survives
in a shared browser profile, and can be exfiltrated by a browser extension. A
production deployment needs one of:

- a **platform key store** (Keychain, Android Keystore) behind a native shell;
- a **hardware-backed key** that signs without exporting;
- **WebAuthn-controlled signing**, where a user gesture authorises each
  signature and the private key never enters the page at all.

The third is the best fit for rvQR's shape — it needs no native shell and it
makes "this device signed it" a claim about a person present at the device
rather than about a string in storage.

## 3. Consequences

### What this buys

- **A pin now means what the UI says it means.** With a fingerprint pinned,
  nothing enters the vault except an artifact whose manifest was signed by it.
- **Signing works at all**, which it did not.
- **The rule is exhaustively testable.** Being pure and total over the verdict
  space, `admitArtifact` has no untested branch.
- **It fails closed by construction**, including for verdict states that do not
  exist yet.

### What it costs, honestly

- **The default is still integrity-only.** No pin means no authenticity, exactly
  as [ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2 describes. Most users
  will never set a pin, and for them nothing about the threat model has changed.
- **A pin is only as good as the fingerprint comparison behind it.** Comparing
  the fingerprint out of band is a human step rvQR cannot perform or verify.
- **The private key is readable by anything on the origin.** §2.4. Until that
  changes, "signed by the pinned key" means "signed by whatever had access to
  that browser's storage".
- **A liveness cost, accepted deliberately.** Refusing on `pending` means a
  verification promise that never settles blocks a transfer that might have been
  perfectly good. Failing closed is the right side to err on, and it is still a
  cost.
- **The artifact is fully received before it is refused.** Admission happens at
  the vault write, so a refused transfer has already been reassembled in memory.
  The bytes are discarded and never stored, but the receiver did the work.
- **Nothing here prevents the sender lying about what it signed.** A signature
  binds a manifest to a key; it says nothing about whether the artifact is
  something you want.

## 4. Acceptance criteria

1. **Exhaustive verdict coverage.** Every row of the table in §2.1 has a test,
   including `unknown-verdict` for a state that does not exist.
2. **The race is closed.** A test drives a verdict that resolves *after* the
   hash check completes and asserts nothing is stored before it lands.
3. **Browser-level proof, not only unit tests.** With a pin set and an unsigned
   transfer, the vault is empty afterwards — asserted in a real browser, because
   that is the layer both original defects lived in. Re-run for `wrong-key` and
   `bad`.
4. **Signing failure is visible.** A test forces the signer to throw and asserts
   the failure is reported rather than becoming a silent `unsigned`.
5. **Argument order is pinned by a test**, so the `(key, manifest)` inversion
   cannot come back.
6. **No-pin behaviour is unchanged**, asserted directly, so the fix cannot
   silently tighten the default and break the primary use.
7. **The admission rule applies on every transport**, including the data channel
   in [ADR-006](./ADR-006-rvqr-p2p-escalation.md) and any future one — one
   admission function, called from one place.
8. **Key custody is tracked as an open item.** This ADR is superseded, not
   amended, when the key leaves `localStorage`.
