# ADR-001: rvQR Optical Transport

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-02 |
| Scope | rvQR v1 — the frame format, the receiver, and the browser app |
| Related | [ADR-009: RVF Version 1 Wire Contract](./ADR-009-rvf-v1-wire-contract.md) (mirrored), [ADR-034: QR Cognitive Seed](./ADR-034-qr-cognitive-seed.md) (mirrored) |

> This is an **rvQR-local** ADR. The other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space. See [README.md](./README.md).

## 1. Context

rvQR moves RVF containers and WASM artifacts between two devices using nothing
but a screen and a camera. There is no network, no pairing, and no shared
account — which removes the usual foundations for framing, retransmission,
authentication and flow control all at once.

Everything below is a decision already implemented and shipped, recorded so the
reasoning survives the code. Where a decision was deliberately deferred, the
Consequences section says so plainly rather than describing the deferral as a
design.

## 2. Decisions

### 2.1 Fixed-size indexed chunks, not fountain coding, for v1

A transfer is a manifest frame plus `ceil(size / chunk)` data frames, each
carrying an explicit sequence number and a base64url payload. The sender loops
the whole stream forever; the receiver collects sequences in any order and
ignores duplicates.

Fixed indexed chunks came first because the failure modes are legible. When a
transfer stalls, "frame 37 never arrived" is a statement a user can act on:
point the camera differently, slow the frame rate, move closer. A rateless code
gives a better channel but a vaguer one, and getting the simple version correct
first meant the receiver's state machine, the integrity rule and the hostile-input
bounds could all be settled before adding erasure coding on top.

The looping stream substitutes for the retransmission this channel cannot have.
There is no back channel, so the sender never learns what the receiver missed;
it simply keeps going, and a frame missed on one pass is caught on the next.
This is why a receiver can join a transfer halfway through and still complete
it.

### 2.2 Integrity without authenticity, stated as a position rather than a gap

Every byte entering the vault is verified against the SHA-256 in the manifest
frame. A mismatch discards the entire transfer; there is no partial acceptance.

The manifest travels in the same unauthenticated stream as the payload, so this
proves the bytes arrived intact and proves nothing about who sent them. Anyone
who can put a screen in front of a camera can produce a perfectly valid
transfer of anything they like.

We decided to ship that rather than wait for signatures, and to say so
everywhere a user might form an expectation — the About tab, the welcome, the
README, the protocol document. The alternative was worse in both directions:
shipping without saying it invites a false sense of safety, and holding the
release for `rvf-crypto` integration would have delayed a genuinely useful
offline transport for a property most of its early uses do not need. An
artifact received by rvQR should be treated exactly like a file downloaded from
a stranger.

### 2.3 Hostile-input ceilings, applied before any value is used

Every field in a frame is unauthenticated input from whatever happens to be in
front of the camera. `parseFrame` therefore bounds the values that drive
allocations and loops *before* a caller can act on them:

| Bound | Value | Reason |
|---|---|---|
| `n` (frame count) | ≤ 65536 | 32 MB at the default chunk, 64 MB at the maximum. Unbounded, one QR code can drive a receiver's data structures. |
| `m.chunk` | ≤ 2953 | The absolute byte capacity of a version 40 symbol at level L. A larger chunk could not have arrived by QR at all. |
| `m.size` | ≤ 256 MB | Bounds the single allocation made when a transfer completes. |
| `m.name` | ≤ 255 chars | Clamped to 120 and stripped of control characters and path separators before use. |

The chunk ceiling is worth singling out because it is derived from the medium
rather than picked: a manifest claiming a chunk larger than a QR symbol can
carry is lying about its own transport, and can be refused on that basis alone.

### 2.4 The renderer is capped independently of any declared total

The receive grid draws at most 4096 cells regardless of what `n` says, bucketing
several frames per cell beyond that point.

This is a separate decision from 2.3 on purpose. Bounding `n` at parse time
already prevents the specific denial of service we found, but "one DOM node per
expected frame" is a shape that is dangerous whenever the count comes from
outside — and a future protocol version may legitimately raise the frame
ceiling. The renderer refuses to be driven by attacker input at all, so the two
mitigations do not have to stay in sync.

### 2.5 Transfer switching on a stall, not on a pin

A receiver adopts the transfer id of the first frame it sees, and then:

| Situation | Behaviour |
|---|---|
| Current transfer finished (verified or rejected) | Adopt the new one immediately |
| Incoming **manifest**, no progress for ≥ 1000 ms | Adopt |
| Incoming **data frame**, no progress for ≥ 3000 ms | Adopt |
| Otherwise | Reject as `other-transfer` |
| No clock available | Never switch mid-transfer |

Pinning the first id forever is the safe-looking choice and the wrong one: a
single stray frame would capture the receiver, and a sender that legitimately
restarts — which it does on every fresh send and every chunk-size change, each
minting a new id — would be stonewalled until the user found a Reset button.

The asymmetric fuses matter. A healthy transfer accepts a frame every few
hundred milliseconds, so neither fuse can expire while it is progressing and a
competing sender in view cannot steal the session. Once the real sender stops,
both fuses burn down and recovery is automatic. This is a liveness trade, not a
safety one: the integrity rule in 2.2 is untouched, so the worst a switch can
cost is progress.

### 2.6 Native scanning first, with a bundled decoder as the fallback

`BarcodeDetector` is used wherever it exists — Chrome, Edge, Safari 17 and
later — because it is faster and far better tested than anything we would
write. Everywhere else, including Firefox and older Safari, rvQR falls back to
its own vendored decoder.

The decoder was written for this project rather than vendored from an existing
library, so that it consumes the version and block tables already in the
encoder (verified bit-exact against a reference implementation across all 40
versions and 4 levels) instead of carrying a second copy that could drift.

Its limits are known and documented: reliable on sharp images at every version,
and on a blurred camera frame reliable to about version 16. The default
512-byte chunk produces version 19, so the app advises a 256-byte chunk when
the receiving device is on the fallback path.

### 2.7 Camera permission in an embedded frame is a host decision, and is reported as one

A cross-origin iframe without `allow="camera"` cannot obtain the camera no
matter what the user clicks. rvQR detects this case specifically and says so,
with a link to open the page standalone, rather than showing a generic
permission failure.

Two receive paths therefore exist that need no camera at all: decoding QR codes
out of an uploaded picture (reading every frame present in one image), and
pasting frame text. Both drive the identical receiver state machine, so neither
is a second-class path with its own bugs.

### 2.8 A keyframe gate in front of the fallback decoder

Camera frames are downsampled to a 16×16 grayscale signature and compared by
mean absolute difference. A decode is attempted only when the picture has
**changed** relative to the last decoded frame and has **settled** relative to
the immediately previous one, with a skip limit that guarantees forward
progress.

The technique is borrowed from [rupixel](https://github.com/ruvnet/rupixel)
(`docs/live.js`, MIT, same author), which uses a 16×16 signature and a
threshold of 9 to decide when a scene has changed enough to re-embed. rvQR
inverts the sense: the expensive operation here is decoding, and a frame caught
mid-pan is motion-blurred and will not decode however much CPU it is given, so
"has it stopped moving?" is as important as "has it changed?". On a synthetic
100-frame sequence with 12 distinct pictures, the gate reduces decode attempts
from 100 to 11.

It is applied only on the fallback path. The native detector is cheap and
handles motion better than a gate would, so throttling it would cost frames for
no saving.

### 2.9 WebAssembly parses untrusted containers and never executes artifacts

rvQR instantiates the RVF microkernel (`@ruvector/rvf-wasm`) to parse RVF
containers in the browser: header, segment table, per-segment CRC, vector count
and dimensionality, and a working nearest-neighbour search.

The distinction this rests on: **instantiating the kernel is this app loading a
tool; the container is data handed to that tool.** The kernel imports nothing,
so an empty import object is its entire interface to the outside world, and a
file that arrived by camera never becomes code because it was parsed. Stored
`.wasm` artifacts are treated differently again — they are compiled, never
instantiated, which is enough to list exports without running an instruction.

A corollary we adopted while implementing this: where the kernel cannot support
an honest claim, the UI reports `unavailable` rather than a green tick. Three
entry points in the published 0.1.9 build do less than their names suggest, and
[docs/ecosystem.md](../ecosystem.md) records exactly what and how it was
established. A verification indicator that does not track verification is worse
than none.

### 2.10 RVF is consumed as specified by ADR-009, not reinterpreted

Container detection and parsing follow the upstream wire contract: the segment
magic `53 46 56 52`, the root manifest magic `30 4D 56 52`, the tail-discovered
4096-byte root manifest, and no header at offset zero. The mnemonics "RVFS" and
"RVM0" are the big-endian rendering of the numeric constants and never appear
as ASCII on the wire — a trap ADR-009 exists to close, and one rvQR's detection
would otherwise have walked into.

rvQR is a transport for that format and deliberately not a second opinion on
it. Where our own reader and the kernel disagree about a container, the app
shows the disagreement rather than silently choosing.

## 3. Consequences

### What this buys

- A transfer either produces a byte-exact artifact or produces nothing. There is
  no path to a partially-correct file in the vault.
- The receiver survives stray frames, sender restarts, duplicate frames, frames
  arriving in any order, and deliberately malformed frames, without a Reset.
- The app is a static page of roughly 150 KB that works from a filesystem, over
  GitHub Pages, and with no installation, no account and no network.
- Receiving works in every browser via at least one of three routes.

### What it costs, honestly

- **Throughput is poor and cannot be argued up.** Payload rate is chunk size ×
  frame rate: 2.5 KB/s at the defaults, 10 KB/s flat out. This is a channel for
  kilobytes and low megabytes.
- **No authenticity.** See 2.2. Signed manifests via `rvf-crypto` are the
  intended remedy and are not implemented.
- **Loss costs time, linearly.** Without erasure coding, a missed frame waits
  for the next pass of the loop. A fountain-coded layer exists in the repository
  and is not yet wired into the transport.
- **The fallback decoder has a density ceiling.** Around version 16 on a blurry
  frame. Mitigated by advice rather than by code.
- **No resume across a browser restart.** Receiver state is in memory; closing
  the tab loses a partial transfer.
- **Delta transfer needs a reverse channel that does not exist.** Sending only
  the changed segments of a container requires the receiver to advertise what it
  has, which means both devices need cameras and the UI needs a second mode.
  That is a change in shape, not a parameter.

### Still roadmap

Erasure-coded frames, delta transfer, signed manifests, BitChat session
bootstrap, and resume after termination. [docs/protocol.md](../protocol.md)
specifies these; none of them are implemented, and the acceptance-test bar
recorded there has not been run.
