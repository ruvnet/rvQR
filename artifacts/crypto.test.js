/*!
 * rvQR crypto test suite — official vectors first, behaviour second.
 *
 * Node: `node artifacts/crypto.test.js`. Exits non-zero on any failure.
 * Browser: load after crypto.js and call RVQRCryptoTests.runAll(crypto).
 *
 * Every asymmetric primitive is run twice, once forced onto WebCrypto and once
 * forced onto the pure-JS implementation, because the fallback is the path most
 * likely to rot unnoticed.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var crypto = require('./crypto.js');
      api.runAll(crypto).then(function (results) {
        results.forEach(function (r) {
          console.log(
            (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')
          );
        });
        var summary = api.summarize(results);
        console.log(
          '\n' + summary.passed + '/' + summary.total + ' passed, ' +
          summary.failed + ' failed'
        );
        if (typeof process !== 'undefined') process.exit(summary.failed ? 1 : 0);
      }, function (e) {
        console.log('FAIL harness crashed: ' + (e && e.stack ? e.stack : e));
        if (typeof process !== 'undefined') process.exit(1);
      });
    }
  } else {
    root.RVQRCryptoTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function summarize(results) {
    var passed = 0;
    results.forEach(function (r) { if (r.ok) passed++; });
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  function runAll(c) {
    var results = [];
    var chain = Promise.resolve();

    // Tests run one at a time so a failure's detail line stays next to its name.
    function test(name, fn) {
      chain = chain.then(function () {
        return Promise.resolve()
          .then(fn)
          .then(function (detail) {
            results.push({ name: name, ok: true, detail: detail || '' });
          }, function (e) {
            results.push({
              name: name, ok: false,
              detail: e && e.message ? e.message : String(e)
            });
          });
      });
    }

    function assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    }
    function assertEqual(actual, expected, msg) {
      if (actual !== expected) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
      }
    }
    function hex(bytes) { return c.toHex(bytes); }
    function bin(str) { return c.fromHex(str); }
    function utf8(str) {
      var out = new Uint8Array(str.length);
      for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    function bytesEqual(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    function repeat(byte, n) {
      var out = new Uint8Array(n);
      out.fill(byte);
      return out;
    }
    // Deterministic pseudo-random bytes so failures are reproducible.
    var seed = 0x5eed1234;
    function rndBytes(n) {
      var out = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        out[i] = (seed >>> 16) & 0xff;
      }
      return out;
    }

    var JS = { backend: 'js' };
    var WC = { backend: 'webcrypto' };

    // -- SHA-2 (FIPS 180-4) --------------------------------------------------

    test('SHA-256 matches FIPS 180-4 examples', function () {
      assertEqual(hex(c.sha256(utf8('abc'))),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc');
      assertEqual(hex(c.sha256(utf8(''))),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty');
      assertEqual(hex(c.sha256(utf8(
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', '448-bit');
      return '3 vectors';
    });

    test('SHA-512 matches FIPS 180-4 examples', function () {
      assertEqual(hex(c.sha512(utf8('abc'))),
        'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
        '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f', 'abc');
      assertEqual(hex(c.sha512(utf8(''))),
        'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
        '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e', 'empty');
      assertEqual(hex(c.sha512(utf8(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn' +
        'hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))),
        '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018' +
        '501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909', 'two-block');
      return '3 vectors';
    });

    // -- HKDF (RFC 5869) -----------------------------------------------------

    test('HKDF-SHA256 matches RFC 5869 case 1', function () {
      var prk = c.hkdfExtract(bin('000102030405060708090a0b0c'), repeat(0x0b, 22));
      assertEqual(hex(prk),
        '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5', 'PRK');
      var okm = c.hkdfExpand(prk, bin('f0f1f2f3f4f5f6f7f8f9'), 42);
      assertEqual(hex(okm),
        '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
        '34007208d5b887185865', 'OKM');
      return 'PRK + OKM';
    });

    test('HKDF-SHA256 matches RFC 5869 case 2 (long inputs)', function () {
      var ikm = new Uint8Array(80), salt = new Uint8Array(80), info = new Uint8Array(80);
      for (var i = 0; i < 80; i++) {
        ikm[i] = i;
        salt[i] = 0x60 + i;
        info[i] = 0xb0 + i;
      }
      var prk = c.hkdfExtract(salt, ikm);
      assertEqual(hex(prk),
        '06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244', 'PRK');
      assertEqual(hex(c.hkdfExpand(prk, info, 82)),
        'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c' +
        '59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71' +
        'cc30c58179ec3e87c14c01d5c1f3434f1d87', 'OKM');
      return 'PRK + OKM';
    });

    test('HKDF-SHA256 matches RFC 5869 case 3 (empty salt and info)', function () {
      var prk = c.hkdfExtract(new Uint8Array(0), repeat(0x0b, 22));
      assertEqual(hex(prk),
        '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04', 'PRK');
      assertEqual(hex(c.hkdfExpand(prk, new Uint8Array(0), 42)),
        '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d' +
        '9d201395faa4b61a96c8', 'OKM');
      return 'PRK + OKM';
    });

    // -- Ed25519 (RFC 8032 §7.1) ---------------------------------------------

    var ED_VECTORS = [
      {
        label: 'TEST 1 (empty message)',
        seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        msg: '',
        sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555' +
          'fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
      },
      {
        label: 'TEST 2 (one byte)',
        seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
        pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
        msg: '72',
        sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
          '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
      },
      {
        label: 'TEST 3 (two bytes)',
        seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
        pub: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
        msg: 'af82',
        sig: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac' +
          '18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'
      },
      {
        label: 'TEST SHA(abc)',
        seed: '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
        pub: 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
        msg: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
          '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
        sig: 'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b589' +
          '09351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704'
      }
    ];

    test('Ed25519 public keys match RFC 8032 §7.1', function () {
      ED_VECTORS.forEach(function (v) {
        assertEqual(hex(c.publicKeyFromSeed(bin(v.seed))), v.pub, v.label);
      });
      return ED_VECTORS.length + ' vectors';
    });

    ['js', 'webcrypto'].forEach(function (backend) {
      var opts = { backend: backend };

      test('Ed25519 signs RFC 8032 §7.1 vectors [' + backend + ']', function () {
        return ED_VECTORS.reduce(function (p, v) {
          return p.then(function () {
            return c.sign(bin(v.seed), bin(v.msg), opts).then(function (sig) {
              assertEqual(hex(sig), v.sig, v.label);
            });
          });
        }, Promise.resolve()).then(function () {
          return ED_VECTORS.length + ' vectors';
        });
      });

      test('Ed25519 verifies RFC 8032 §7.1 vectors [' + backend + ']', function () {
        return ED_VECTORS.reduce(function (p, v) {
          return p.then(function () {
            return c.verify(bin(v.pub), bin(v.msg), bin(v.sig), opts).then(function (ok) {
              assert(ok, v.label + ' should verify');
            });
          });
        }, Promise.resolve()).then(function () {
          return ED_VECTORS.length + ' vectors';
        });
      });

      test('Ed25519 rejects tampering [' + backend + ']', function () {
        var v = ED_VECTORS[3];
        var msg = bin(v.msg), sig = bin(v.sig), pub = bin(v.pub);

        var badMsg = bin(v.msg); badMsg[0] ^= 0x01;
        var badSig = bin(v.sig); badSig[0] ^= 0x01;
        var badSigTail = bin(v.sig); badSigTail[63] ^= 0x01;
        var badKey = bin(v.pub); badKey[0] ^= 0x01;

        return Promise.all([
          c.verify(pub, badMsg, sig, opts),
          c.verify(pub, msg, badSig, opts),
          c.verify(pub, msg, badSigTail, opts),
          c.verify(badKey, msg, sig, opts),
          c.verify(pub, msg, sig.subarray(0, 63), opts),
          c.verify(bin(ED_VECTORS[0].pub), msg, sig, opts)
        ]).then(function (r) {
          assert(!r[0], 'tampered message must not verify');
          assert(!r[1], 'tampered signature R must not verify');
          assert(!r[2], 'tampered signature S must not verify');
          assert(!r[3], 'tampered public key must not verify');
          assert(!r[4], 'truncated signature must not verify');
          assert(!r[5], 'wrong signer must not verify');
          return '6 rejections';
        });
      });

      test('Ed25519 roundtrips a fresh key pair [' + backend + ']', function () {
        var kp = c.generateKeyPair();
        var msg = rndBytes(200);
        return c.sign(kp.privateKey, msg, opts).then(function (sig) {
          assertEqual(sig.length, 64, 'signature length');
          return c.verify(kp.publicKey, msg, sig, opts).then(function (ok) {
            assert(ok, 'roundtrip must verify');
            return 'signed 200 bytes';
          });
        });
      });
    });

    test('Ed25519 signatures cross-verify between backends', function () {
      var kp = c.generateKeyPair();
      var msg = utf8('cross-backend agreement');
      return Promise.all([
        c.sign(kp.privateKey, msg, JS),
        c.sign(kp.privateKey, msg, WC)
      ]).then(function (sigs) {
        assertEqual(hex(sigs[0]), hex(sigs[1]), 'both backends must produce the same signature');
        return Promise.all([
          c.verify(kp.publicKey, msg, sigs[1], JS),
          c.verify(kp.publicKey, msg, sigs[0], WC)
        ]).then(function (r) {
          assert(r[0], 'js must verify a WebCrypto signature');
          assert(r[1], 'WebCrypto must verify a js signature');
          return 'identical bytes, both directions verify';
        });
      });
    });

    test('Ed25519 rejects a non-canonical S (malleability)', function () {
      // S + L is congruent mod L but must not verify: RFC 8032 §5.1.7 requires
      // S < L, and without that check a signature has two valid encodings.
      var v = ED_VECTORS[1];
      var L = bin('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
      var sig = bin(v.sig);
      var carry = 0;
      for (var i = 0; i < 32; i++) {
        var sum = sig[32 + i] + L[i] + carry;
        sig[32 + i] = sum & 0xff;
        carry = sum >>> 8;
      }
      assertEqual(carry, 0, 'S+L should not overflow 32 bytes');
      return Promise.all([
        c.verify(bin(v.pub), bin(v.msg), sig, JS),
        c.verify(bin(v.pub), bin(v.msg), sig, WC)
      ]).then(function (r) {
        assert(!r[0], 'js must reject S+L');
        assert(!r[1], 'WebCrypto must reject S+L');
        return 'both backends reject';
      });
    });

    // -- X25519 (RFC 7748) ---------------------------------------------------

    var ALICE_SK = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
    var ALICE_PK = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
    var BOB_SK = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
    var BOB_PK = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
    var SHARED = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

    test('X25519 derives RFC 7748 §6.1 public keys', function () {
      assertEqual(hex(c.x25519Base(bin(ALICE_SK))), ALICE_PK, 'alice');
      assertEqual(hex(c.x25519Base(bin(BOB_SK))), BOB_PK, 'bob');
      return '2 keys';
    });

    test('X25519 matches RFC 7748 §5.2 scalar multiplication', function () {
      assertEqual(
        hex(c.x25519Raw(
          bin('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
          bin('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'))),
        'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552', 'vector 1');
      assertEqual(
        hex(c.x25519Raw(
          bin('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'),
          bin('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493'))),
        '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957', 'vector 2');
      return '2 vectors';
    });

    ['js', 'webcrypto'].forEach(function (backend) {
      test('X25519 both parties agree on RFC 7748 §6.1 secret [' + backend + ']', function () {
        var opts = { backend: backend };
        return Promise.all([
          c.x25519Agree(bin(ALICE_SK), bin(BOB_PK), opts),
          c.x25519Agree(bin(BOB_SK), bin(ALICE_PK), opts)
        ]).then(function (r) {
          assertEqual(hex(r[0]), SHARED, 'alice');
          assertEqual(hex(r[1]), SHARED, 'bob');
          return 'K = ' + SHARED.slice(0, 16) + '...';
        });
      });
    });

    test('X25519 rejects low-order points that force a zero secret', function () {
      // The all-zero u-coordinate is in the small subgroup: every private key
      // maps it to zero, so accepting it would let anyone pin the session key.
      return c.x25519Agree(bin(ALICE_SK), new Uint8Array(32), JS).then(function () {
        throw new Error('all-zero peer key was accepted');
      }, function (e) {
        assert(/zero/.test(e.message), 'expected an all-zero-secret error, got: ' + e.message);
        return 'rejected: ' + e.message;
      });
    });

    // -- ChaCha20-Poly1305 (RFC 8439) ----------------------------------------

    var SUNSCREEN = utf8(
      'Ladies and Gentlemen of the class of \'99: If I could offer you ' +
      'only one tip for the future, sunscreen would be it.');

    test('ChaCha20 matches RFC 8439 §2.4.2', function () {
      var out = c.chacha20(
        bin('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
        bin('000000000000004a00000000'), 1, SUNSCREEN);
      assertEqual(hex(out),
        '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
        'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
        '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
        '5af90bbf74a35be6b40b8eedf2785e42874d', 'keystream');
      return '114 bytes';
    });

    test('Poly1305 matches RFC 8439 §2.5.2', function () {
      assertEqual(
        hex(c.poly1305(
          bin('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b'),
          utf8('Cryptographic Forum Research Group'))),
        'a8061dc1305136c6c22b8baf0c0127a9', 'tag');
      return 'tag matches';
    });

    test('ChaCha20-Poly1305 matches RFC 8439 §2.8.2', function () {
      var key = bin('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
      var nonce = bin('070000004041424344454647');
      var aad = bin('50515253c0c1c2c3c4c5c6c7');
      return c.aeadSeal(key, nonce, SUNSCREEN, aad).then(function (sealed) {
        assertEqual(hex(sealed.subarray(0, sealed.length - 16)),
          'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6' +
          '3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36' +
          '92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc' +
          '3ff4def08e4b7a9de576d26586cec64b6116', 'ciphertext');
        assertEqual(hex(sealed.subarray(sealed.length - 16)),
          '1ae10b594f09e26a7e902ecbd0600691', 'tag');
        return c.aeadOpen(key, nonce, sealed, aad).then(function (pt) {
          assert(pt !== null && bytesEqual(pt, SUNSCREEN), 'must decrypt back');
          return 'ciphertext + tag + roundtrip';
        });
      });
    });

    test('AES-256-GCM matches GCM specification test case 16', function () {
      var key = bin('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
      var nonce = bin('cafebabefacedbaddecaf888');
      var aad = bin('feedfacedeadbeeffeedfacedeadbeefabaddad2');
      var pt = bin('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72' +
        '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39');
      var opts = { suite: c.SUITE_AESGCM };
      return c.aeadSeal(key, nonce, pt, aad, opts).then(function (sealed) {
        assertEqual(hex(sealed),
          '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa' +
          '8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' +
          '76fc6ece0f4e1768cddf8853bb2d551b', 'ciphertext || tag');
        return c.aeadOpen(key, nonce, sealed, aad, opts).then(function (back) {
          assert(back !== null && bytesEqual(back, pt), 'must decrypt back');
          return 'ciphertext + tag + roundtrip';
        });
      });
    });

    [
      { name: 'ChaCha20-Poly1305', opts: {} },
      { name: 'AES-256-GCM', opts: { suite: 'aes-256-gcm' } }
    ].forEach(function (suite) {
      test('AEAD binds associated data [' + suite.name + ']', function () {
        var key = rndBytes(32), nonce = rndBytes(12);
        var pt = utf8('the payload'), aad = utf8('frame 7 of 40');
        return c.aeadSeal(key, nonce, pt, aad, suite.opts).then(function (sealed) {
          var tamperedCt = sealed.slice(); tamperedCt[2] ^= 0x40;
          var tamperedTag = sealed.slice(); tamperedTag[sealed.length - 1] ^= 0x01;
          var otherAad = utf8('frame 8 of 40');
          return Promise.all([
            c.aeadOpen(key, nonce, sealed, aad, suite.opts),
            c.aeadOpen(key, nonce, tamperedCt, aad, suite.opts),
            c.aeadOpen(key, nonce, tamperedTag, aad, suite.opts),
            c.aeadOpen(key, nonce, sealed, otherAad, suite.opts),
            c.aeadOpen(key, nonce, sealed, new Uint8Array(0), suite.opts),
            c.aeadOpen(key, rndBytes(12), sealed, aad, suite.opts)
          ]).then(function (r) {
            assert(r[0] !== null && bytesEqual(r[0], pt), 'honest open must succeed');
            assert(r[1] === null, 'tampered ciphertext must fail');
            assert(r[2] === null, 'tampered tag must fail');
            // The reference BitChat example accepts an aad argument and never
            // feeds it to the cipher; these two cases are what catches that.
            assert(r[3] === null, 'changed associated data must fail');
            assert(r[4] === null, 'dropped associated data must fail');
            assert(r[5] === null, 'wrong nonce must fail');
            return '5 rejections, aad genuinely bound';
          });
        });
      });
    });

    // -- canonical manifest encoding -----------------------------------------

    var MANIFEST = {
      name: 'report.pdf',
      size: 1048576,
      sha256: 'a'.repeat(64),
      chunk: 512
    };

    test('canonical manifest is stable under key reordering', function () {
      var forward = {
        name: MANIFEST.name, size: MANIFEST.size,
        sha256: MANIFEST.sha256, chunk: MANIFEST.chunk
      };
      var reversed = {
        chunk: MANIFEST.chunk, sha256: MANIFEST.sha256,
        size: MANIFEST.size, name: MANIFEST.name
      };
      var interleaved = {
        sha256: MANIFEST.sha256, name: MANIFEST.name,
        chunk: MANIFEST.chunk, size: MANIFEST.size
      };
      var a = hex(c.canonicalManifestBytes(forward));
      assertEqual(hex(c.canonicalManifestBytes(reversed)), a, 'reversed key order');
      assertEqual(hex(c.canonicalManifestBytes(interleaved)), a, 'interleaved key order');
      // An explicit undefined is the same as an absent optional field.
      assertEqual(hex(c.canonicalManifestBytes({
        name: MANIFEST.name, size: MANIFEST.size, sha256: MANIFEST.sha256,
        chunk: MANIFEST.chunk, transferId: undefined
      })), a, 'undefined optional field');
      return c.canonicalManifestBytes(forward).length + ' bytes, 4 orderings';
    });

    test('canonical manifest roundtrips through decode', function () {
      var full = {
        name: 'ünïcødé пример.bin', size: 9007199254740991, sha256: 'f'.repeat(64),
        chunk: 2953, transferId: 'deadbeef', total: 65535,
        createdAt: 1770000000000, sessionId: '0011223344556677', codecs: 3
      };
      var bytes = c.canonicalManifestBytes(full);
      var decoded = c.decodeCanonicalManifest(bytes);
      assert(decoded.ok, 'decode failed: ' + decoded.reason);
      Object.keys(full).forEach(function (k) {
        assertEqual(decoded.manifest[k], full[k], k);
      });
      return Object.keys(full).length + ' fields, ' + bytes.length + ' bytes';
    });

    test('canonical manifest rejects non-canonical input', function () {
      function rejects(manifest, why) {
        var threw = false;
        try {
          c.canonicalManifestBytes(manifest);
        } catch (e) {
          threw = true;
        }
        assert(threw, why + ' should have been rejected');
      }
      function base(over) {
        var m = {
          name: MANIFEST.name, size: MANIFEST.size,
          sha256: MANIFEST.sha256, chunk: MANIFEST.chunk
        };
        Object.keys(over).forEach(function (k) { m[k] = over[k]; });
        return m;
      }
      rejects(base({ extra: 1 }), 'unknown field');
      rejects(base({ sha256: 'A'.repeat(64) }), 'uppercase hex');
      rejects(base({ sha256: 'a'.repeat(63) }), 'short hash');
      rejects(base({ size: '1048576' }), 'numeric string');
      rejects(base({ size: 1.5 }), 'non-integer size');
      rejects(base({ size: -1 }), 'negative size');
      rejects(base({ name: '' }), 'empty name');
      rejects(base({ name: 'a b' }), 'control character in name');
      rejects(base({ transferId: 'deadbee' }), 'odd-length transferId');
      rejects({ name: 'a', size: 1, sha256: 'a'.repeat(64) }, 'missing chunk');
      rejects('not an object', 'non-object');
      return '11 rejections';
    });

    test('canonical manifest decoder rejects malformed bytes without throwing', function () {
      var good = c.canonicalManifestBytes(MANIFEST);
      var cases = [
        [new Uint8Array(0), 'empty'],
        [good.subarray(0, 10), 'truncated'],
        [c.fromHex('00'.repeat(40)), 'zeroed'],
        [(function () { var b = good.slice(); b[0] ^= 0xff; return b; })(), 'bad magic'],
        [(function () { var b = good.slice(); b[8] = 99; return b; })(), 'field count too high'],
        [(function () {
          var b = new Uint8Array(good.length + 1);
          b.set(good);
          return b;
        })(), 'trailing byte'],
        [(function () { var b = good.slice(); b[9] = 3; return b; })(), 'reordered tags'],
        [rndBytes(64), 'random bytes'],
        ['a string', 'not bytes']
      ];
      cases.forEach(function (pair) {
        var r = c.decodeCanonicalManifest(pair[0]);
        assert(r && r.ok === false, pair[1] + ' should be rejected');
        assert(typeof r.reason === 'string' && r.reason.length, pair[1] + ' needs a reason');
      });
      assert(c.decodeCanonicalManifest(good).ok, 'the honest encoding must still decode');
      return cases.length + ' malformed inputs, all reasoned';
    });

    ['js', 'webcrypto'].forEach(function (backend) {
      test('signed manifest verifies and detects edits [' + backend + ']', function () {
        var opts = { backend: backend };
        var kp = c.generateKeyPair();
        return c.signManifest(kp.privateKey, MANIFEST, opts).then(function (sig) {
          var reordered = {
            chunk: MANIFEST.chunk, sha256: MANIFEST.sha256,
            size: MANIFEST.size, name: MANIFEST.name
          };
          var renamed = {
            name: 'invoice.pdf', size: MANIFEST.size,
            sha256: MANIFEST.sha256, chunk: MANIFEST.chunk
          };
          var resized = {
            name: MANIFEST.name, size: MANIFEST.size + 1,
            sha256: MANIFEST.sha256, chunk: MANIFEST.chunk
          };
          var other = c.generateKeyPair();
          return Promise.all([
            c.verifyManifest(kp.publicKey, MANIFEST, sig, opts),
            c.verifyManifest(kp.publicKey, reordered, sig, opts),
            c.verifyManifest(kp.publicKey, renamed, sig, opts),
            c.verifyManifest(kp.publicKey, resized, sig, opts),
            c.verifyManifest(other.publicKey, MANIFEST, sig, opts),
            c.verifyManifest(kp.publicKey, { name: 'x' }, sig, opts)
          ]).then(function (r) {
            assert(r[0], 'honest manifest must verify');
            assert(r[1], 'key order must not affect the signature');
            assert(!r[2], 'a renamed artifact must not verify');
            assert(!r[3], 'a resized artifact must not verify');
            assert(!r[4], 'a different signer must not verify');
            assert(!r[5], 'an invalid manifest must not verify');
            return 'verified, 4 rejections';
          });
        });
      });
    });

    // -- fingerprints ---------------------------------------------------------

    test('fingerprint is stable and formatted for reading aloud', function () {
      var pk = bin(ED_VECTORS[0].pub);
      var fp = c.fingerprint(pk);
      assertEqual(fp, c.fingerprint(pk.slice()), 'must be deterministic');
      assert(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(fp), 'unexpected format: ' + fp);
      assertEqual(fp.replace(/-/g, ''), hex(c.sha256(pk).subarray(0, 8)),
        'must be the first 8 bytes of SHA-256');
      assert(c.fingerprintEqual(fp, fp.toUpperCase()), 'case must not matter');
      assert(c.fingerprintEqual(fp, fp.replace(/-/g, '')), 'grouping must not matter');
      assert(!c.fingerprintEqual(fp, c.fingerprint(bin(ED_VECTORS[1].pub))),
        'different keys must differ');
      assert(!c.fingerprintEqual(fp, ''), 'empty must not match');
      assert(!c.fingerprintEqual(fp, null), 'null must not match');
      assert(c.matchesPin(pk, fp), 'matchesPin should accept its own key');
      assert(!c.matchesPin(bin(ED_VECTORS[1].pub), fp), 'matchesPin should reject another key');
      return fp;
    });

    // -- bootstrap payload ----------------------------------------------------

    test('bootstrap payload fits a low QR version', function () {
      var unsigned = c.bootstrapQrEstimate(false);
      var signed = c.bootstrapQrEstimate(true);
      assertEqual(unsigned.payloadBytes, 74, 'unsigned bytes');
      assertEqual(unsigned.qrCharacters, 106, 'unsigned characters');
      assertEqual(unsigned.versionL, 5, 'unsigned QR version at ECC L');
      assertEqual(signed.payloadBytes, 138, 'signed bytes');
      assertEqual(signed.qrCharacters, 191, 'signed characters');
      assertEqual(signed.versionL, 8, 'signed QR version at ECC L');
      return 'unsigned 74B/106ch/v5-L, signed 138B/191ch/v8-L';
    });

    test('bootstrap roundtrips and carries a verifiable self-signature', function () {
      var identity = c.generateKeyPair();
      var eph = c.x25519GenerateKeyPair();
      var sessionId = rndBytes(8);
      return c.encodeBootstrapString({
        sessionId: sessionId,
        x25519PublicKey: eph.publicKey,
        ed25519PublicKey: identity.publicKey,
        codecs: c.CODEC_CHACHA20_POLY1305 | c.CODEC_FOUNTAIN,
        identityPrivateKey: identity.privateKey
      }).then(function (text) {
        assertEqual(text.length, 191, 'signed bootstrap length');
        assertEqual(text.slice(0, 7), c.BOOTSTRAP_PREFIX, 'prefix');
        var parsed = c.parseBootstrap(text);
        assert(parsed.ok, 'parse failed: ' + parsed.reason);
        assert(bytesEqual(parsed.bootstrap.sessionId, sessionId), 'session id');
        assert(bytesEqual(parsed.bootstrap.x25519PublicKey, eph.publicKey), 'x25519 key');
        assert(bytesEqual(parsed.bootstrap.ed25519PublicKey, identity.publicKey), 'identity key');
        assertEqual(parsed.bootstrap.codecs,
          c.CODEC_CHACHA20_POLY1305 | c.CODEC_FOUNTAIN, 'codecs');
        return c.verifyBootstrapSignature(parsed.bootstrap).then(function (ok) {
          assert(ok, 'self-signature must verify');
          // Flipping a byte of the advertised ephemeral key must break it.
          var mangled = parsed.bootstrap.bytes.slice();
          mangled[12] ^= 0x01;
          var reparsed = c.parseBootstrap(c.BOOTSTRAP_PREFIX + c.b64uEncode(mangled));
          assert(reparsed.ok, 'mangled payload should still parse');
          return c.verifyBootstrapSignature(reparsed.bootstrap).then(function (bad) {
            assert(!bad, 'a substituted ephemeral key must break the signature');
            return '191 chars, signature binds the ephemeral key';
          });
        });
      });
    });

    test('bootstrap parser rejects malformed input without throwing', function () {
      var cases = [
        [undefined, 'undefined'], [null, 'null'], [42, 'number'], [{}, 'object'],
        ['', 'empty string'],
        ['rvqrb1:', 'prefix only'],
        ['nope:AAAA', 'wrong prefix'],
        ['rvqrb1:!!!!', 'invalid base64'],
        ['rvqrb1:' + 'A'.repeat(600), 'oversized'],
        ['rvqrb1:' + 'A'.repeat(100), 'wrong length'],
        ['rvqrb1:' + 'A'.repeat(99), 'unsupported version'],
        [c.BOOTSTRAP_PREFIX + c.b64uEncode(rndBytes(74)), 'random 74 bytes']
      ];
      cases.forEach(function (pair) {
        var r = c.parseBootstrap(pair[0]);
        assert(r && typeof r.ok === 'boolean', pair[1] + ' must return a result');
        if (!r.ok) {
          assert(typeof r.reason === 'string' && r.reason.length, pair[1] + ' needs a reason');
        }
      });
      // A payload whose signature flag disagrees with its length is rejected.
      var payload = new Uint8Array(74);
      payload[0] = 1;
      payload[1] = 0x80 | 1; // claims a signature that is not there
      var r = c.parseBootstrap(c.BOOTSTRAP_PREFIX + c.b64uEncode(payload));
      assert(!r.ok && r.reason === 'signature-flag-mismatch', 'flag/length mismatch');
      return cases.length + 1 + ' malformed inputs';
    });

    // -- sessions -------------------------------------------------------------

    ['js', 'webcrypto'].forEach(function (backend) {
      test('session handshake agrees on keys and seals both ways [' + backend + ']', function () {
        var opts = { backend: backend };
        var initiatorIdentity = c.generateKeyPair();
        return c.sessionInvite({
          identity: initiatorIdentity, backend: backend
        }).then(function (state) {
          var pin = c.fingerprint(initiatorIdentity.publicKey);
          return c.sessionAccept(state.bootstrap, {
            backend: backend, pinnedFingerprint: pin
          }).then(function (acc) {
            assert(acc.ok, 'accept failed: ' + acc.reason);
            assert(acc.session.identityVerified, 'pinned identity should be marked verified');
            return c.sessionConfirm(state, acc.bootstrap, opts).then(function (conf) {
              assert(conf.ok, 'confirm failed: ' + conf.reason);
              var a = conf.session, b = acc.session;
              assertEqual(a.sessionId, b.sessionId, 'session id');
              assertEqual(hex(a.sendKey), hex(b.recvKey), 'initiator send == responder recv');
              assertEqual(hex(a.recvKey), hex(b.sendKey), 'responder send == initiator recv');
              assert(hex(a.sendKey) !== hex(a.recvKey), 'directions must use different keys');
              assertEqual(a.suite, 'chacha20-poly1305', 'negotiated suite');

              var msg = utf8('frame payload');
              var aad = utf8('transfer 0xdeadbeef');
              return c.seal(a, msg, aad).then(function (rec) {
                return c.open(b, rec, aad).then(function (got) {
                  assert(got.ok, 'responder failed to open: ' + got.reason);
                  assert(bytesEqual(got.plaintext, msg), 'plaintext mismatch');
                  return c.seal(b, utf8('ack'), aad).then(function (back) {
                    return c.open(a, back, aad).then(function (got2) {
                      assert(got2.ok, 'initiator failed to open: ' + got2.reason);
                      assertEqual(String.fromCharCode.apply(null, got2.plaintext), 'ack', 'ack');
                      return 'keys agree, both directions seal and open';
                    });
                  });
                });
              });
            });
          });
        });
      });
    });

    test('session rejects a man-in-the-middle who swaps the ephemeral key', function () {
      // The attacker controls what the camera sees, so they can replace the
      // whole bootstrap. With the identity pinned out of band, they cannot
      // produce a signature over their own key, and the handshake stops.
      var honest = c.generateKeyPair();
      var attacker = c.generateKeyPair();
      var pin = c.fingerprint(honest.publicKey);
      return c.sessionInvite({ identity: attacker }).then(function (evil) {
        return c.sessionAccept(evil.bootstrap, { pinnedFingerprint: pin }).then(function (r) {
          assert(!r.ok, 'a substituted identity must not be accepted');
          assertEqual(r.reason, 'identity-not-pinned', 'reason');
          // An unsigned bootstrap is equally unacceptable when pinning.
          return c.sessionInvite({ identity: honest, sign: false }).then(function (bare) {
            return c.sessionAccept(bare.bootstrap, { pinnedFingerprint: pin }).then(function (r2) {
              assert(!r2.ok, 'an unsigned bootstrap must not satisfy a pin');
              assertEqual(r2.reason, 'unsigned-bootstrap', 'reason');
              return 'substituted identity and unsigned invite both refused';
            });
          });
        });
      });
    });

    test('session tolerates reordering but refuses replays', function () {
      return c.sessionInvite({}).then(function (state) {
        return c.sessionAccept(state.bootstrap, {}).then(function (acc) {
          return c.sessionConfirm(state, acc.bootstrap, {}).then(function (conf) {
            var send = conf.session, recv = acc.session;
            var aad = utf8('ctx');
            var records = [];
            var chain = Promise.resolve();
            for (var i = 0; i < 5; i++) {
              (function (n) {
                chain = chain.then(function () {
                  return c.seal(send, utf8('record ' + n), aad).then(function (r) {
                    records.push(r);
                  });
                });
              })(i);
            }
            return chain.then(function () {
              // Deliver out of order, as an optical channel does.
              return c.open(recv, records[3], aad).then(function (a) {
                assert(a.ok, 'record 3 out of order: ' + a.reason);
                return c.open(recv, records[1], aad).then(function (b) {
                  assert(b.ok, 'record 1 after 3: ' + b.reason);
                  return c.open(recv, records[3], aad).then(function (dup) {
                    assert(!dup.ok && dup.reason === 'replayed', 'replay must be refused');
                    var forged = records[4].slice();
                    forged[forged.length - 1] ^= 0x01;
                    return c.open(recv, forged, aad).then(function (bad) {
                      assert(!bad.ok && bad.reason === 'auth-failed', 'forgery must fail');
                      // A forgery must not burn the counter slot it claimed.
                      return c.open(recv, records[4], aad).then(function (ok4) {
                        assert(ok4.ok, 'honest record 4 still opens: ' + ok4.reason);
                        return 'out-of-order ok, replay and forgery refused';
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });

    test('session records bind their associated data and counter', function () {
      return c.sessionInvite({}).then(function (state) {
        return c.sessionAccept(state.bootstrap, {}).then(function (acc) {
          return c.sessionConfirm(state, acc.bootstrap, {}).then(function (conf) {
            var aad = utf8('frame 7');
            return c.seal(conf.session, utf8('secret'), aad).then(function (rec) {
              var moved = rec.slice();
              moved[7] ^= 0x01; // claim a different counter
              return Promise.all([
                c.open(acc.session, rec, utf8('frame 8')),
                c.open(acc.session, moved, aad),
                c.open(acc.session, rec.subarray(0, 8), aad),
                c.open(acc.session, 'nonsense', aad)
              ]).then(function (r) {
                assert(!r[0].ok, 'changed aad must fail');
                assert(!r[1].ok, 'changed counter must fail');
                assert(!r[2].ok && r[2].reason === 'too-short', 'truncated record');
                assert(!r[3].ok, 'non-bytes record must be refused, not thrown');
                return '4 rejections';
              });
            });
          });
        });
      });
    });

    test('malformed keys and signatures resolve false instead of throwing', function () {
      var junk = [undefined, null, 'string', 42, {}, new Uint8Array(0), rndBytes(31), rndBytes(33)];
      var checks = [];
      junk.forEach(function (j) {
        checks.push(c.verify(j, utf8('m'), rndBytes(64), JS));
        checks.push(c.verify(rndBytes(32), utf8('m'), j, JS));
      });
      // A well-formed but off-curve public key is a verification failure too.
      checks.push(c.verify(repeat(0xff, 32), utf8('m'), rndBytes(64), JS));
      return Promise.all(checks).then(function (r) {
        r.forEach(function (ok, i) {
          assert(ok === false, 'input ' + i + ' should verify false, got ' + ok);
        });
        return r.length + ' malformed inputs, all false';
      });
    });

    test('capabilities reports which backends this platform provides', function () {
      return c.capabilities().then(function (caps) {
        assert(typeof caps === 'object' && caps !== null, 'capabilities must be an object');
        ['subtle', 'ed25519', 'x25519', 'hkdf', 'aesGcm'].forEach(function (k) {
          assertEqual(typeof caps[k], 'boolean', k);
        });
        return 'subtle=' + caps.subtle + ' ed25519=' + caps.ed25519 +
          ' x25519=' + caps.x25519 + ' aesGcm=' + caps.aesGcm;
      });
    });

    return chain.then(function () { return results; });
  }

  return { runAll: runAll, summarize: summarize };
});
