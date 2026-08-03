/*!
 * rvQR RVF binding — parses RVF containers with the real @ruvector/rvf-wasm
 * microkernel, and reads vector segments directly.
 *
 * Two things to understand before reading this file.
 *
 * 1. Instantiating the microkernel is not "running the artifact". The kernel is
 *    a tool this app loads deliberately; the container is data handed *to* it.
 *    A scanned file never becomes code because it was scanned.
 *
 * 2. Every number here carries its provenance. Some kernel entry points in the
 *    published 0.1.9 build do less than their names suggest — rvf_verify_checksum
 *    returns success for deliberately corrupted input, rvf_witness_count errors
 *    on every length, and rvf_store_open reads this container's vector header
 *    fields transposed. Those are documented inline where they matter and
 *    surfaced to the UI as `unavailable` rather than dressed up as passes. A
 *    green tick that means nothing is worse than no tick.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRRvf = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ISO segment types, from rvf-types/src/segment_type.rs upstream.
  var SEGMENT_TYPES = {
    0x00: 'Invalid', 0x01: 'Vec', 0x02: 'Index', 0x03: 'Overlay',
    0x04: 'Journal', 0x05: 'Manifest', 0x06: 'Quant', 0x07: 'Meta',
    0x08: 'Hot', 0x09: 'Sketch', 0x0a: 'Witness', 0x0b: 'Profile',
    0x0c: 'Crypto', 0x0d: 'MetaIdx', 0x0e: 'Kernel', 0x0f: 'Ebpf',
    0x10: 'Wasm', 0x11: 'Dashboard', 0x20: 'CowMap', 0x21: 'Refcount',
    0x22: 'Membership', 0x23: 'Delta', 0x30: 'TransferPrior',
    0x31: 'PolicyKernel', 0x32: 'CostCurve', 0x33: 'FederatedManifest',
    0x34: 'DiffPrivacyProof', 0x35: 'RedactionLog', 0x36: 'AggregateWeights',
    // rvQR-local, per ADR-020. Upstream's table ends at 0x36 in the version this
    // app bundles, so 0x37 is the next free slot. Named here only so the segment
    // table reads as 'Provenance' rather than 'type 0x37'; provenance.js owns
    // the payload, and a reader without it walks past this segment unchanged.
    0x37: 'Provenance'
  };

  var SEGMENT_HEADER_SIZE = 64;
  var VEC_TYPE = 0x01;

  // Metric ids the kernel's query entry point accepts. The names are inferred
  // from observed output ranges, not from a published table.
  var METRICS = [
    { id: 2, name: 'cosine' },
    { id: 0, name: 'euclidean' },
    { id: 1, name: 'inner product' }
  ];

  function typeName(t) {
    return SEGMENT_TYPES[t] || ('type 0x' + t.toString(16));
  }

  // ---------------------------------------------------------------------------
  // Kernel loading
  // ---------------------------------------------------------------------------

  var runtimePromise = null;

  /**
   * Instantiates the microkernel. It imports nothing, so an empty import object
   * is the whole contract: it cannot reach the DOM, the network or storage.
   */
  function load(source) {
    if (runtimePromise) return runtimePromise;
    runtimePromise = Promise.resolve()
      .then(function () {
        if (source instanceof Uint8Array || source instanceof ArrayBuffer) return source;
        return fetch(source || './demo/rvf_wasm_bg.wasm').then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        });
      })
      .then(function (bytes) {
        return WebAssembly.instantiate(bytes, {});
      })
      .then(function (result) {
        var exports = result.instance ? result.instance.exports : result.exports;
        if (!exports || typeof exports.rvf_alloc !== 'function') {
          throw new Error('not an RVF microkernel: rvf_alloc missing');
        }
        return new Kernel(exports);
      })
      .catch(function (err) {
        runtimePromise = null; // let a later attempt retry
        throw err;
      });
    return runtimePromise;
  }

  function Kernel(exports) {
    this.exports = exports;
  }

  Kernel.prototype.bytes = function () {
    return new Uint8Array(this.exports.memory.buffer);
  };
  Kernel.prototype.view = function () {
    return new DataView(this.exports.memory.buffer);
  };

  /** Copies data in, runs fn(ptr, len), always frees. */
  Kernel.prototype.withBuffer = function (data, fn) {
    var ptr = this.exports.rvf_alloc(data.length);
    if (!ptr) throw new Error('rvf_alloc failed for ' + data.length + ' bytes');
    try {
      this.bytes().set(data, ptr);
      return fn(ptr, data.length);
    } finally {
      this.exports.rvf_free(ptr, data.length);
    }
  };

  Kernel.prototype.withScratch = function (size, fn) {
    var ptr = this.exports.rvf_alloc(size);
    if (!ptr) throw new Error('rvf_alloc failed for ' + size + ' bytes');
    try {
      return fn(ptr);
    } finally {
      this.exports.rvf_free(ptr, size);
    }
  };

  // ---------------------------------------------------------------------------
  // Vector segment reader (JavaScript)
  // ---------------------------------------------------------------------------

  /**
   * Reads a Vec segment payload.
   *
   * Layout, confirmed byte-exactly against the shipped demo container:
   *   u16 dim | u16 count | u16 flags | count × { u64 id, dim × f32 }
   * The record stride is 8 + dim*4, and 6 + stride*count accounts for the
   * payload exactly. This reader is what the app trusts for ids and vectors.
   */
  function readVectorSegment(bytes, payloadOffset, payloadSize) {
    if (payloadSize < 6) return { ok: false, reason: 'vector segment too short' };
    var dv = new DataView(bytes.buffer, bytes.byteOffset + payloadOffset, payloadSize);
    var dim = dv.getUint16(0, true);
    var count = dv.getUint16(2, true);
    var flags = dv.getUint16(4, true);
    if (!dim || !count) return { ok: false, reason: 'vector segment declares no vectors' };

    var stride = 8 + dim * 4;
    var needed = 6 + stride * count;
    if (needed > payloadSize) {
      return {
        ok: false,
        reason: 'declared ' + count + ' × ' + dim + 'd needs ' + needed +
          ' bytes but the segment holds ' + payloadSize
      };
    }

    var ids = new Array(count);
    var vectors = new Array(count);
    for (var i = 0; i < count; i++) {
      var base = 6 + i * stride;
      // Ids are u64 on the wire. Numbers past 2^53 would be silently mangled,
      // so keep those as strings rather than lie about the value.
      var lo = dv.getUint32(base, true);
      var hi = dv.getUint32(base + 4, true);
      ids[i] = hi === 0 ? lo : (hi * 4294967296 + lo);
      if (hi > 0x1fffff) ids[i] = '0x' + hi.toString(16) + ('00000000' + lo.toString(16)).slice(-8);
      var v = new Float32Array(dim);
      for (var d = 0; d < dim; d++) v[d] = dv.getFloat32(base + 8 + d * 4, true);
      vectors[i] = v;
    }
    return {
      ok: true, dim: dim, count: count, flags: flags,
      ids: ids, vectors: vectors, trailing: payloadSize - needed
    };
  }

  // ---------------------------------------------------------------------------
  // Container inspection
  // ---------------------------------------------------------------------------

  /**
   * Walks a container with the kernel and reports what is actually known.
   * Never throws on malformed input — every length in the file is untrusted.
   */
  function inspect(kernel, data) {
    var e = kernel.exports;
    var report = {
      ok: false, size: data.length, header: null, segments: [],
      vectors: null, store: null, checks: [], notes: []
    };

    try {
      kernel.withBuffer(data, function (ptr, len) {
        // --- header -------------------------------------------------------
        kernel.withScratch(64, function (out) {
          var rc = e.rvf_parse_header(ptr, len, out);
          if (rc === 0) {
            var dv = kernel.view();
            report.header = {
              magic: dv.getUint32(out, true),
              magicBytes: Array.prototype.slice
                .call(kernel.bytes().subarray(out, out + 4))
                .map(function (b) { return ('0' + b.toString(16)).slice(-2); })
                .join(' '),
              version: kernel.bytes()[out + 4],
              type: kernel.bytes()[out + 5],
              id: dv.getUint32(out + 8, true),
              payloadSize: dv.getUint32(out + 16, true)
            };
            report.header.typeName = typeName(report.header.type);
          } else {
            report.notes.push(
              rc === -2 ? 'No RVF segment magic at offset 0.'
                : 'Header could not be read (rc ' + rc + ').'
            );
          }
        });

        var headerOk = e.rvf_verify_header(ptr) === 0; // 0 = valid, 1 = not
        report.checks.push({
          name: 'Segment magic',
          status: headerOk ? 'pass' : 'fail',
          detail: headerOk
            ? 'Starts with the v1 segment magic 53 46 56 52, per ADR-009.'
            : 'The first four bytes are not the RVF segment magic.'
        });

        // --- segment table ------------------------------------------------
        var count = e.rvf_segment_count(ptr, len);
        report.segmentCount = count;
        for (var i = 0; i < count && i < 4096; i++) {
          var seg = kernel.withScratch(64, function (out) {
            var rc = e.rvf_segment_info(ptr, len, i, out);
            if (rc !== 0) return null;
            var dv = kernel.view();
            // Packed struct: u64 id, u32 type, u64 size, u64 offset.
            return {
              index: i,
              id: dv.getUint32(out, true),
              type: dv.getUint32(out + 8, true),
              size: dv.getUint32(out + 12, true),
              offset: dv.getUint32(out + 20, true)
            };
          });
          if (!seg) break;
          seg.typeName = typeName(seg.type);
          seg.payloadOffset = seg.offset + SEGMENT_HEADER_SIZE;
          // A CRC over the payload, computed by the kernel. The container
          // carries no reference CRC to compare against, so this is a
          // fingerprint for comparing two copies — not a verification.
          if (seg.payloadOffset + seg.size <= len) {
            seg.crc32c = (e.rvf_crc32c(ptr + seg.payloadOffset, seg.size) >>> 0)
              .toString(16).padStart(8, '0');
          }
          report.segments.push(seg);
        }

        // Does the segment chain account for the whole file?
        var covered = report.segments.reduce(function (acc, s) {
          return Math.max(acc, s.payloadOffset + s.size);
        }, 0);
        var slack = data.length - covered;
        report.checks.push({
          name: 'Segment chain',
          status: report.segments.length ? (slack >= 0 && slack < 64 ? 'pass' : 'warn') : 'fail',
          detail: report.segments.length
            ? report.segments.length + ' segments accounting for ' + covered +
              ' of ' + data.length + ' bytes' +
              (slack > 0 ? ' (' + slack + ' bytes of 64-byte alignment padding)' : '')
            : 'No segments could be walked.'
        });

        // --- vectors ------------------------------------------------------
        var vecSeg = null;
        for (var v = 0; v < report.segments.length; v++) {
          if (report.segments[v].type === VEC_TYPE) { vecSeg = report.segments[v]; break; }
        }
        if (vecSeg && vecSeg.payloadOffset + vecSeg.size <= data.length) {
          report.vectors = readVectorSegment(data, vecSeg.payloadOffset, vecSeg.size);
        } else if (vecSeg) {
          report.vectors = { ok: false, reason: 'vector segment runs past the end of the file' };
        }
        report.checks.push({
          name: 'Vector segment',
          status: report.vectors && report.vectors.ok ? 'pass' : (vecSeg ? 'fail' : 'unavailable'),
          detail: report.vectors && report.vectors.ok
            ? report.vectors.count + ' vectors of ' + report.vectors.dim +
              ' dimensions, ids read directly from the segment'
            : vecSeg ? report.vectors.reason : 'This container has no Vec segment.'
        });

        // --- kernel store path --------------------------------------------
        // Opened deliberately so its answer can be compared with the reader
        // above. rvf_store_open returns a handle for any input at all — it is
        // not a validity check, so nothing here treats it as one.
        var handle = e.rvf_store_open(ptr, len);
        if (handle > 0) {
          var storeCount = e.rvf_store_count(handle);
          var storeDim = e.rvf_store_dimension(handle);
          report.store = { handle: handle, count: storeCount, dimension: storeDim };
          if (report.vectors && report.vectors.ok) {
            var agrees = storeCount === report.vectors.count && storeDim === report.vectors.dim;
            var transposed = storeCount === report.vectors.dim && storeDim === report.vectors.count;
            report.store.agrees = agrees;
            report.store.transposed = transposed;
            report.checks.push({
              name: 'Kernel store cross-check',
              status: agrees ? 'pass' : 'warn',
              detail: agrees
                ? 'The bundled kernel agrees: ' + storeCount + ' × ' + storeDim + '.'
                : 'The bundled 0.1.9 kernel reports count ' + storeCount + ' and dimension ' +
                  storeDim + (transposed ? ', which is this container\'s values transposed. ' : '. ') +
                  'The segment itself is unambiguous, so the reader above is what this app uses ' +
                  'for ids, dimensions and search.'
            });
          }
          e.rvf_store_close(handle);
        }

        // --- things this build cannot do ----------------------------------
        // rvf_verify_checksum returns success for deliberately corrupted
        // containers, so reporting it as a pass would be inventing assurance.
        report.checks.push({
          name: 'Checksum verification',
          status: 'unavailable',
          detail: 'The kernel\'s rvf_verify_checksum returns success even for corrupted ' +
            'containers in the published 0.1.9 build, and this container carries no ' +
            'reference CRC to compare against. Per-segment CRC32C values are shown as ' +
            'fingerprints instead.'
        });
        var witnessSeg = report.segments.filter(function (s) { return s.type === 0x0a; });
        report.checks.push({
          name: 'Witness chain',
          status: 'unavailable',
          detail: witnessSeg.length
            ? 'A Witness segment is present (' + witnessSeg[0].size + ' bytes), but the ' +
              'kernel\'s rvf_witness_count rejects every chain length in this build, so ' +
              'the chain cannot be verified here.'
            : 'No Witness segment in this container.'
        });

        report.ok = headerOk && report.segments.length > 0;
      });
    } catch (err) {
      report.notes.push('Inspection failed: ' + (err && err.message ? err.message : String(err)));
    }
    return report;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  function distance(a, b, metric) {
    var dot = 0, na = 0, nb = 0, sum = 0;
    for (var i = 0; i < a.length; i++) {
      var d = a[i] - b[i];
      sum += d * d;
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (metric === 'euclidean') return Math.sqrt(sum);
    if (metric === 'inner product') return -dot;
    var denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? 1 - dot / denom : 1;
  }

  /** Exhaustive search over the vectors read from the segment. */
  function queryVectors(parsedVectors, query, k, metric) {
    if (!parsedVectors || !parsedVectors.ok) return [];
    var results = [];
    for (var i = 0; i < parsedVectors.count; i++) {
      results.push({
        id: parsedVectors.ids[i],
        distance: distance(query, parsedVectors.vectors[i], metric || 'cosine'),
        index: i
      });
    }
    results.sort(function (a, b) { return a.distance - b.distance; });
    return results.slice(0, k || 5);
  }

  /**
   * The same query through the kernel's own store, so the two can be compared.
   * Returns null when the kernel cannot open the container.
   */
  function queryStore(kernel, data, query, k, metricId) {
    var e = kernel.exports;
    try {
      return kernel.withBuffer(data, function (ptr, len) {
        var handle = e.rvf_store_open(ptr, len);
        if (handle <= 0) return null;
        try {
          var dim = e.rvf_store_dimension(handle);
          if (dim <= 0 || dim > 4096) return null;
          return kernel.withScratch(dim * 4, function (qptr) {
            var dv = kernel.view();
            for (var i = 0; i < dim; i++) {
              dv.setFloat32(qptr + i * 4, i < query.length ? query[i] : 0, true);
            }
            return kernel.withScratch(Math.max(k, 1) * 12 + 16, function (out) {
              var rc = e.rvf_store_query(handle, qptr, k, metricId, out);
              if (rc <= 0) return null;
              var view = kernel.view();
              var rows = [];
              for (var r = 0; r < rc; r++) {
                var p = out + r * 12;
                var lo = view.getUint32(p, true);
                var hi = view.getUint32(p + 4, true);
                rows.push({
                  id: hi === 0 ? lo : '0x' + hi.toString(16) + ('00000000' + lo.toString(16)).slice(-8),
                  distance: view.getFloat32(p + 8, true)
                });
              }
              return rows;
            });
          });
        } finally {
          e.rvf_store_close(handle);
        }
      });
    } catch (err) {
      return null;
    }
  }

  function randomUnitVector(dim) {
    var v = new Float32Array(dim);
    var norm = 0;
    for (var i = 0; i < dim; i++) {
      // Box-Muller keeps the direction uniform on the sphere.
      var u1 = Math.random() || 1e-9, u2 = Math.random();
      v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (var j = 0; j < dim; j++) v[j] /= norm;
    return v;
  }

  return {
    load: load,
    inspect: inspect,
    readVectorSegment: readVectorSegment,
    queryVectors: queryVectors,
    queryStore: queryStore,
    randomUnitVector: randomUnitVector,
    distance: distance,
    typeName: typeName,
    SEGMENT_TYPES: SEGMENT_TYPES,
    SEGMENT_HEADER_SIZE: SEGMENT_HEADER_SIZE,
    METRICS: METRICS
  };
});
