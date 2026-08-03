# Using rvQR

Two devices, a screen and a camera, no network in between. One device turns a
file into a stream of QR codes; the other watches, collects the frames, checks
the hash, and stores the result.

This guide is the written version of the **Guide** tab in the app. If you have
the app open, work through it there — the buttons are right next to the text.

---

## Try it in 60 seconds

You need two devices that can both open [`../artifacts/`](../artifacts/). Two
phones, or a laptop and a phone. They do not need to be on the same network.
They do not need to be on *any* network.

**1. Load the demo container.** On the **Vault** tab, tap
`ruvnet demo .rvf`. That is a real RVF container: 24 vectors of 16 dimensions,
2,304 bytes, five QR frames. It is small on purpose — the whole transfer takes
a couple of seconds, so you can see the mechanism without waiting.

**2. Send it.** Tap the artifact in the vault, then **Send this**. The QR
stream starts immediately and loops forever. Leave that screen showing.

**3. Receive it.** On the second device, go to **Receive** and tap **Start
camera**. Point it at the first screen, close enough that the QR code fills
most of the view. If the camera is unavailable — an embedded page, a locked-down
browser, no camera at all — photograph the sending screen instead and drop the
picture into the image box. Both routes end up in the same place.

**4. Watch it land.** The bar fills and the grid lights up cell by cell as
frames arrive, in whatever order they happen to be caught. When the last frame
lands, the bytes are hashed and compared against the manifest.

**5. Open what you received.** Tap the new artifact. You get the container's
real segment table, and a search box: randomise a query vector and watch the
nearest ids come back ranked by distance. A vector database, delivered by
camera.

---

## Sending

Pick an artifact, and the app slices it into frames. Two settings decide
whether the other device can keep up.

**Chunk size** is how many bytes ride in each frame, from 128 to 1024. Bigger
chunks mean fewer frames but a denser symbol, and density is the real limit —
a 1024-byte chunk produces a 125×125-module QR code that a phone camera will
only resolve held close and steady. 512 bytes is a good default. Drop to 256 if
the receiving device is struggling, or if it is using rvQR's own decoder rather
than a native one.

**Speed** is frames per second, from 2 to 10. Faster finishes sooner but gives
the camera less time on each frame. Five is comfortable. Drop to two or three in
poor light.

The stream **loops forever**. There is no back channel, so the sender never
learns what the receiver missed — it simply keeps going, and a frame missed on
one pass is picked up on the next. This is why you can start the receiver
halfway through and still get a complete file.

The **progress ring** shows where the sender is in its loop. It is not the
receiver's progress. The sender has no idea what the receiver has.

### How fast is it, really?

Payload rate is chunk size × frame rate, and both are small numbers:

| Setting | Rate | The 2.3 KB demo | A 40 KB module |
|---------|------|-----------------|----------------|
| 512 B at 5 fps (default) | 2.5 KB/s | about 1 second | about 16 seconds |
| 1024 B at 10 fps (maximum) | 10 KB/s | under a second | about 4 seconds |

This is a channel for kilobytes and low megabytes. It is not a way to move your
photo library.

---

## Receiving

Three routes, all feeding the same receiver and the same integrity check.

### Camera

The fastest route. rvQR uses the browser's native barcode reader when there is
one, and its own bundled decoder when there is not. The Receive tab tells you
which is in use.

Hold both devices steady, fill the camera with the QR code, and avoid glare.
The same things that make any QR scan work.

### A picture

Photograph or screenshot the sending screen, then drop the image into the
picture box. **Every frame visible in the picture is read at once** — if you
catch four codes in one shot, you get four frames.

This route works in every browser, needs no camera permission, and is the
answer when the page is embedded in a frame that does not grant camera access.
A screenshot is also *sharper* than a photograph, so it decodes more reliably.

### Pasted text

If you can copy a frame's contents as text, paste it in — one frame per line.
Mostly useful for debugging, and it drives exactly the same receiving logic as
the other two routes.

### Reading the progress display

The **bar and grid** are the real progress. Each cell is one frame, lit once
that frame has been read. Gaps fill in as the sender loops around again. On a
very large transfer one cell stands for several frames, and the app says so.

The counters show **duplicates** — harmless and expected, since the sender is
looping — and **rejected** frames, meaning unreadable input or frames belonging
to a different transfer.

### When frames stop arriving

If the sender restarts, it mints a new transfer id, and the receiver switches
to it automatically once the old transfer has gone quiet for a moment. You do
not need to press Reset. Reset is there for when you want to abandon a
half-finished transfer deliberately.

---

## Inspecting what you received

### RVF containers

rvQR parses RVF containers with the real RVF WebAssembly microkernel — the same
binary published as `@ruvector/rvf-wasm`, which is also one of the demo
artifacts. You get:

- the header: magic bytes, version, and the type of the first segment;
- the **segment table**: every segment with its type, size, offset, and a
  CRC32C fingerprint computed by the kernel;
- for containers with a `Vec` segment, the **vector count and dimensionality**,
  read straight out of the segment;
- a **working nearest-neighbour search** over those vectors, with cosine,
  euclidean and inner-product metrics.

Querying a container with one of its own stored vectors returns that vector's
id at distance zero. That is the quickest way to confirm the search is real
rather than decorative.

**On instantiating WebAssembly.** Loading the microkernel is this app choosing
to run a tool. The container is data handed *to* that tool. A file you received
by camera never becomes code because you looked at it.

**On checks that are not made.** Where rvQR cannot verify something honestly, it
says `unavailable` rather than showing a green tick. Two cases in the published
0.1.9 kernel:

- `rvf_verify_checksum` returns success even for deliberately corrupted
  containers, and this container carries no reference checksum to compare
  against. The per-segment CRC32C values are shown as fingerprints — useful for
  comparing two copies of a container, not as proof of integrity.
- `rvf_witness_count` rejects every chain length, so a Witness segment can be
  seen in the table but its chain cannot be verified here.

There is also a **cross-check**: rvQR compares what its own reader found against
what the kernel's `rvf_store_open` reports. For the bundled demo container these
disagree — the 0.1.9 kernel reads the vector header's two fields transposed,
reporting 16 vectors of 24 dimensions where the file plainly holds 24 of 16.
The app shows the disagreement instead of silently picking a winner, and uses
its own reader, which is the one that matches the bytes on disk.

### WASM modules

A `.wasm` artifact is compiled with `WebAssembly.compile` and its exports and
imports are listed. Compiling validates the module and reveals its shape;
it does not run a single instruction. Instantiation is the step that could run
code, and rvQR never takes it for a stored artifact.

---

## What is actually guaranteed

**Integrity: yes.** Nothing enters the vault unless the reassembled bytes hash
to exactly the SHA-256 in the manifest frame. One wrong bit discards the entire
transfer — there is no partial acceptance.

**Authenticity: no.** The manifest travels in the same unauthenticated stream as
the data. Anyone who can put a screen in front of your camera can send you a
perfectly valid transfer of anything they like. rvQR detects corruption and
accidents; it does not detect a liar. Treat what arrives the way you would treat
a file downloaded from a stranger. Signed manifests are on the roadmap — see
[protocol.md](./protocol.md).

**Execution: never.** Receiving a file does not run it, and rvQR has no
mechanism that would.

---

## Browser reality

**Sending** works anywhere with a canvas.

**Receiving with the camera** uses the native `BarcodeDetector` API in Chrome
and Edge, and in Safari 17 and later. Everywhere else — Firefox, older Safari —
rvQR falls back to its own decoder. That decoder handles the smaller symbols
comfortably and wants a sharper image on the densest ones: reliable up to about
version 16 (81 modules) on a blurry camera frame, and good to version 40 on a
sharp screenshot. If you are sending to a device on the fallback decoder, a
256-byte chunk keeps every frame well inside the comfortable range.

**Embedded pages.** If rvQR is running inside an iframe that was not given
camera permission by its host page, no amount of clicking will grant it — that
is the surrounding page's decision. The app detects this and says so. Open rvQR
in its own tab, or use the picture route.

**Opening from disk.** `file://` works for everything except loading the two
demo artifacts and the microkernel, because browsers block reading neighbouring
files from disk. Serve the folder over http — any local static server will do —
or import your own files instead.

---

## Running the tests

Open [`../artifacts/test.html`](../artifacts/test.html) in a browser: it runs
the protocol, encoder, decoder and RVF suites in-page and shows pass or fail,
plus two live QR codes you can scan with any reader to confirm the encoder
produces genuinely readable symbols.

The same suite runs under Node:

```bash
node artifacts/tests.js
```
