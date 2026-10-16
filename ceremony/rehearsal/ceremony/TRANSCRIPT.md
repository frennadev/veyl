# REHEARSAL transcript (practice run, NOT the production keys): Veyl circuits

> This is a rehearsal with simulated participants and a fixed test beacon. Its keys must never be used for real funds and preflight never accepts it.

Groth16 phase-2 ceremony for `withdraw`, `transact`, `position`, `swap`, `claim`, finalized 2026-10-13T12:19:23.289Z with snarkjs 0.7.6. Every contributor contributed to every circuit; the same random beacon closes each. The circuits are unchanged: only their proving and verifying keys are new.

## withdraw

| | |
|---|---|
| circuit | `zk/circuits/withdraw.circom` sha256 `9288a362447d0b6b1bc2de8b199d6b5ac9e09bded44089ac75f89dfc1b8046aa` |
| compiler | circom 2.2.3 (circom2@0.2.23), circomlib 2.0.5, `--r1cs --wasm --O2` |
| r1cs sha256 | `9a082b4875428805aaf15e7b8de6e9ff229f5af6b5f245ea28821d144aacb9f8` |
| wasm sha256 (witness generator, unchanged) | `49fb1888c9b78f488802e9dce63c659f0b35f7ea42dde4b910c9c2d615f96aa8` |
| constraints / wires / public signals | 14237 / 14295 / 6 |
| circuit hash (snarkjs) | `8a8200095ebbbc48b5efdd282f827e95e59d493781db7ef25ccc70a13b651ebe6818b475ed45e559b2177198837a657242fc2f1b66344ed7f74e1eb067242735` |
| phase 1 | `pot16_final.ptau`, 2^16, blake2b-512 `a8d10a0bb0f9f3f28bc7e815db0d8fccbf7a24bf6e3d6b6cf63a67c51de4d3a4b0d0f50df59f9ceb3edec13781a7ac4fe236ce76690cdd94627f565fbc05b314` (a local rehearsal file, not the public ceremony) |

Phase 2 contributions (3 + beacon):

| # | contributor | contribution hash (blake2b-512) | key after it (sha256) | time |
|---|---|---|---|---|
| 1 | rehearsal-participant-1 | `600fce37e801011db78fb51ddcbbb2d1f7853191e6c1872134a3407f65b571d6439d440af5f63c22235c25062757e3cc9526f826c3eb0a57b94206fcb3660e60` | `148a663b08aed41aeabd8ed1d9ee4229649d59813ae5145c309b549b30c42935` | 2026-10-13T11:54:11.815Z |
| 2 | rehearsal-participant-2 | `a34c121a82ff540fc02fc8021fb6b5a268a295045d63ef0a43d864d6b69b200fc85dd0969a483f97b6891cc9a30235f8d11bb0554a6cf6b5790b2333502ec2c6` | `eb946fcaa7a9916207ae37ed702dd14bc58e241cd4db1d98ffb7c3ec1920ede8` | 2026-10-13T11:59:47.223Z |
| 3 | rehearsal-participant-3 | `d87d1da499bc4c17ec9987ee974637368a3882e9465ace993c0d478560fcb002dd78f5d0987912cc02b418ddb09c3f9613c5f37b6078fba6279747af0759de79` | `7967a017e0133e90fef9508149931ee07d20883bf2a6f300ed956e3a6ce76c5c` | 2026-10-13T12:05:08.361Z |
| 4 | **beacon** | `7dd9efedaad8498736bcf2130757266996217317fffae87e84db52aec54ca812c246f6a03bc5bea58921f7cfedaff419976ec178ffcba59fd3516446e377e8f1` | `3b693da8eb9d02b72cc14ddbb3f1492ade843c9a45f304719176c02c991a467e` | 2026-10-13T12:10:31.024Z |

Beacon: REHEARSAL fixed test value (not a real beacon). Value `7665796c2072656865617273616c3a206120666978656420746573742076616c75652c206e6f742061207265616c20626561636f6e`, hashed 2^10 times.

| result | sha256 |
|---|---|
| zk/keys/withdraw_final.zkey | `3b693da8eb9d02b72cc14ddbb3f1492ade843c9a45f304719176c02c991a467e` |
| zk/keys/withdraw_vkey.json | `3c742ddb154ac99c7b88b6bd7430d99bc463e6da3d08c34e6610fdf3ce0e7b98` |
| programs/veyl_pool/src/vkey.rs | `77d5e09f06a74799369f190cf9e90f7e1e3f242be45bc2a29670d6d4b32fdeb9` |

## transact

| | |
|---|---|
| circuit | `zk/circuits/transact.circom` sha256 `a32bbca20635637dbdf7b6fde0c64e86adbb61507a603882bac3fdd00197cb29` |
| compiler | circom 2.2.3 (circom2@0.2.23), circomlib 2.0.5, `--r1cs --wasm --O2` |
| r1cs sha256 | `476892c930dea98a683ce9569c186e30e553b62fe9f4ea344a2c5fb087f234b8` |
| wasm sha256 (witness generator, unchanged) | `53fda2850bb0debcbbfd1512e415418f6e67d8aa09025611911b7d89cbd1bd10` |
| constraints / wires / public signals | 18475 / 18549 / 8 |
| circuit hash (snarkjs) | `f2685bbdb35e9c22c4142e46b7fdcaf571a5931152f9924db580a09ccc3467a61e00780982aa1e44014b463058290347f91702bf83f2630dc02dae3c1bdb5a3d` |
| phase 1 | `pot16_final.ptau`, 2^16, blake2b-512 `a8d10a0bb0f9f3f28bc7e815db0d8fccbf7a24bf6e3d6b6cf63a67c51de4d3a4b0d0f50df59f9ceb3edec13781a7ac4fe236ce76690cdd94627f565fbc05b314` (a local rehearsal file, not the public ceremony) |

Phase 2 contributions (3 + beacon):

| # | contributor | contribution hash (blake2b-512) | key after it (sha256) | time |
|---|---|---|---|---|
| 1 | rehearsal-participant-1 | `9281cc9f200993a816122c0f142fbf6618a4d2d267e3d92370791e0bf564a30d007ebd29e4a374fcf924f1af81afda531be68b6d6a59c1c2cef1fdad02fb4ef9` | `caeaeb348a04e1c2fd9b382ac061d7a0a6b1fb4114d7b4f08409259bd9f04ad9` | 2026-10-13T11:55:34.320Z |
| 2 | rehearsal-participant-2 | `94e5b24fec8728d4a6bf60dafb33be9b6c2acb195e897eaa89e016941931ff7d551f4c1fda42dfd68718600cdd2c5a9d10973d1d99684f7dcfa00c64ea124ca3` | `e7a34657142f7cebe72148aaebb2b83a19205cb1f24cc0e31fa9277975a984e3` | 2026-10-13T12:00:51.337Z |
| 3 | rehearsal-participant-3 | `44c26d2b98c134d25d24756d6ec4eb8c41d318cf56820267cfca251677d0fa225ac2504b5fdb58f7227a7c0cdd90e5d4fed9987651e787714c1ef8d469d53f8b` | `51a4fc6356da92ebcce1f5f18c21745cf773e217244c19561b20701c66cc35b3` | 2026-10-13T12:06:15.179Z |
| 4 | **beacon** | `bf5fa83fd7422fcfe14474fc1a8340c5d57e07bf7df04403245401e2877e5ae7ee99ead57e812bbc4b2b8553b2f5d2beea5a538f25ae7f7ad90f2bed29af92f0` | `c4ecee1bd875183a8e9c8ece81bfe66e12f5f4f5daf2f941aace40e30c35e66d` | 2026-10-13T12:11:33.747Z |

Beacon: REHEARSAL fixed test value (not a real beacon). Value `7665796c2072656865617273616c3a206120666978656420746573742076616c75652c206e6f742061207265616c20626561636f6e`, hashed 2^10 times.

| result | sha256 |
|---|---|
| zk/keys/transact_final.zkey | `c4ecee1bd875183a8e9c8ece81bfe66e12f5f4f5daf2f941aace40e30c35e66d` |
| zk/keys/transact_vkey.json | `ca47c0bd299eeb0073100f1f6cf331ced9422d47f1f33ac29488b5ee68a9ed25` |
| programs/veyl_pool/src/vkey_transact.rs | `f2d1141bf97aeba823c78563f4b387e0881b80396bcd5b984632453de6fc349f` |

## position

| | |
|---|---|
| circuit | `zk/circuits/position.circom` sha256 `f86510d2de56e681926b6f118d617fc0cef64324372b2b9932a7a2061b3aaa95` |
| compiler | circom 2.2.3 (circom2@0.2.23), circomlib 2.0.5, `--r1cs --wasm --O2` |
| r1cs sha256 | `b8141bc467b3bd5e5f3fa7acc9cdc772630858799190b22724c00a9ccb617885` |
| wasm sha256 (witness generator, unchanged) | `5df5325d8321be986e56fbaec9130b26b2f605949774cad59785f4cd0d13cea8` |
| constraints / wires / public signals | 17219 / 17291 / 8 |
| circuit hash (snarkjs) | `30ad70deb0b4a8337f1ee60d637ff44a982e1cf36e275f549a307d8df17b7ba1c3c59805d77346d4f635db0978e800e1208a54a1b562ec062233c919e4d54a76` |
| phase 1 | `pot16_final.ptau`, 2^16, blake2b-512 `a8d10a0bb0f9f3f28bc7e815db0d8fccbf7a24bf6e3d6b6cf63a67c51de4d3a4b0d0f50df59f9ceb3edec13781a7ac4fe236ce76690cdd94627f565fbc05b314` (a local rehearsal file, not the public ceremony) |

Phase 2 contributions (3 + beacon):

| # | contributor | contribution hash (blake2b-512) | key after it (sha256) | time |
|---|---|---|---|---|
| 1 | rehearsal-participant-1 | `9f926b018085a7d5c16380f5ec301597844684b7ac5796c093ffcebecb01826c3432e7a1e2da2f10909eb22139fdfbc82320aaf58f4b94be93923e7c912142e4` | `bf9b7f0ea1e1f2e1bb45cbbe16308b4ee66810679e00828b04633eb5cc81ec48` | 2026-10-13T11:56:55.851Z |
| 2 | rehearsal-participant-2 | `eb0e7a728941b10d0b4ebbdd102e0fe010a916f1b34e2fee633161ab00895706d787f6181bcc25fb13097e7f1ee205bb18756ef6998157c01abd3c3b5b42ff15` | `2e02ccacb29482f0d531b997c290c29b0027835bdb1e1ab67033c286d12f7911` | 2026-10-13T12:02:15.177Z |
| 3 | rehearsal-participant-3 | `277dbad2b8ed27534f78e013f1eb677b3802f4be91f2e79ff1707f837b12048c97262364e8d3e60499a02f8692cda091a5ad621c6b352e16c330a1ec8ba215b9` | `61f6f6c80a303079ab6e07552949f9570940dda9a0513616f2cca4fb292d9857` | 2026-10-13T12:07:39.741Z |
| 4 | **beacon** | `506d1563ae89183e5b68f12633c1686158ed8e64e0eed6d75e97f0dc249b8336ce661259631709857721a2faba0debdceff152bc6ccd2fb0168f7586b3e6c1a9` | `635ceccf6042ef4f89752281bbd98ab4216792a664996ebbde86ca9514e1d2ee` | 2026-10-13T12:12:52.391Z |

Beacon: REHEARSAL fixed test value (not a real beacon). Value `7665796c2072656865617273616c3a206120666978656420746573742076616c75652c206e6f742061207265616c20626561636f6e`, hashed 2^10 times.

| result | sha256 |
|---|---|
| zk/keys/position_final.zkey | `635ceccf6042ef4f89752281bbd98ab4216792a664996ebbde86ca9514e1d2ee` |
| zk/keys/position_vkey.json | `7f696b916d675a38460b802ba34b76dd41083f22d52e12acde3ca8bf23ec1448` |
| programs/veyl_pool/src/vkey_position.rs | `783dac1b1f0392d2ca4b5e70032c2b3a85ae3a947db76862f5186e754241bac4` |

## swap

| | |
|---|---|
| circuit | `zk/circuits/swap.circom` sha256 `62f775720626f15721689a6d8c0ddfd0464a115f6a0e2c0f27424ff5ef1006a7` |
| compiler | circom 2.2.3 (circom2@0.2.23), circomlib 2.0.5, `--r1cs --wasm --O2` |
| r1cs sha256 | `066c921e883645dc54efbfe0e53c2ea1507b9253cb44782dbfd4e70040a95e98` |
| wasm sha256 (witness generator, unchanged) | `09b734a86446c5785b1d9ba57a3cabb1176c69113b1e3bd5da72f5d5645d3e36` |
| constraints / wires / public signals | 23426 / 23501 / 8 |
| circuit hash (snarkjs) | `47cbfc955fd29cde36017b0d37ff39072008c6387477b704273719651e0fdda50d6a43025f824ee640938dafeb7e664df72ac832b370a0c288cda314f0433539` |
| phase 1 | `pot16_final.ptau`, 2^16, blake2b-512 `a8d10a0bb0f9f3f28bc7e815db0d8fccbf7a24bf6e3d6b6cf63a67c51de4d3a4b0d0f50df59f9ceb3edec13781a7ac4fe236ce76690cdd94627f565fbc05b314` (a local rehearsal file, not the public ceremony) |

Phase 2 contributions (3 + beacon):

| # | contributor | contribution hash (blake2b-512) | key after it (sha256) | time |
|---|---|---|---|---|
| 1 | rehearsal-participant-1 | `0b5962e0336d70e7447847110d8f82e6c67b068c52b86c090791870531dc9449f432ac71e2c992f8b810d3221873cb16f7dcbe6b5431d2293ed71c2c07724312` | `103782b54b4a1109718df56ce73dfc038c5585b53aa7411769dc28f205cf8398` | 2026-10-13T11:58:08.427Z |
| 2 | rehearsal-participant-2 | `e86caf8e19b1c9f35e40a7b9557771f82748d87705b52fd3590d22a16cf7ce6117378c342157ab945e259b3ec38117541553a878a90426aa0e526107fda641e1` | `c00778e125847d45f199a33e63256435ffe48e470ace21207a0067ad2bb19db8` | 2026-10-13T12:03:26.677Z |
| 3 | rehearsal-participant-3 | `d54d8f1e024aefa59935338f0b09d53e52f0aaca915613e39b4cdbfd1335def3d01a2af0503ab827c921545d0892e4665bdc731aa084d9b0e8193c52f13e79b0` | `336f7c84c166ae628129ec4ad76d8312717cb5ac29d575d9a48dcb9fc03c6726` | 2026-10-13T12:08:51.028Z |
| 4 | **beacon** | `b7eea5c4ddc7be78b248fc71e12636bfd8cef0e1936b063105f416bd5dcab01ecbfeafd3a20555b9b229251e95fc30ee84276a5ba5df41529f1c706fd3651973` | `9078abd18bd72990bed8ac92cb7ede5dfa533d6a14bb092d4a474d279451a8ec` | 2026-10-13T12:13:59.058Z |

Beacon: REHEARSAL fixed test value (not a real beacon). Value `7665796c2072656865617273616c3a206120666978656420746573742076616c75652c206e6f742061207265616c20626561636f6e`, hashed 2^10 times.

| result | sha256 |
|---|---|
| zk/keys/swap_final.zkey | `9078abd18bd72990bed8ac92cb7ede5dfa533d6a14bb092d4a474d279451a8ec` |
| zk/keys/swap_vkey.json | `809bcf113fc0359bef58fa8253ab02654b9e473725e518853921bf308b6a3c5f` |
| programs/veyl_pool/src/vkey_swap.rs | `356415eba4a3ee99c4ab2283e10425db1458dad79cb7bd816f7e958548ebdc24` |

## claim

| | |
|---|---|
| circuit | `zk/circuits/claim.circom` sha256 `960f15efa90e31aa8c08131012f904817b79aabc6bded6165d7bfaeb8e5db1fc` |
| compiler | circom 2.2.3 (circom2@0.2.23), circomlib 2.0.5, `--r1cs --wasm --O2` |
| r1cs sha256 | `f5c92abf910cfc333fd02714fd83b5322293191ef372d018e940d099a1658d48` |
| wasm sha256 (witness generator, unchanged) | `637144c214feff3fb7129b3698828250743938a0caa3fb36f63457f4aabbb33a` |
| constraints / wires / public signals | 9942 / 9979 / 6 |
| circuit hash (snarkjs) | `4f929b71e0107e89453869d000aec457397dc4981c7a899503442ad6c8a7ba41ed65c7ab48305e4af335a59174307f71ee901964ecc11d4ca7545582c331339c` |
| phase 1 | `pot16_final.ptau`, 2^16, blake2b-512 `a8d10a0bb0f9f3f28bc7e815db0d8fccbf7a24bf6e3d6b6cf63a67c51de4d3a4b0d0f50df59f9ceb3edec13781a7ac4fe236ce76690cdd94627f565fbc05b314` (a local rehearsal file, not the public ceremony) |

Phase 2 contributions (3 + beacon):

| # | contributor | contribution hash (blake2b-512) | key after it (sha256) | time |
|---|---|---|---|---|
| 1 | rehearsal-participant-1 | `0d371ff5db1e65f05a5a16b7a1678ca65e90b1f6616bb74f8116de3f1272b57c5bb9d504c013c5c4e58504b7013fcb4dbb79ac63c4cc4db5c56475a9ef5895b4` | `e14bec3b4760554af461cc1a9c76f3c3c4b0806f00fb31fea1e9bac34dc5ae0e` | 2026-10-13T11:58:53.136Z |
| 2 | rehearsal-participant-2 | `aa079e2927ffef90bc14edf60f355ba01e5a27f87cc626a92c7a159b01a7f4e4a5189213c868b197f449aeb8be3a97dc9c5c192735f988281c24f8462d5fb1bd` | `2b52d04eb78c966b2e75bac5ed00f69be52b68a96ac9e158bc0e6687877e9582` | 2026-10-13T12:04:13.371Z |
| 3 | rehearsal-participant-3 | `ab4866afea11ac08bd5d477a5dcac01d645e3921594d884d7f6670eff11780f3671c4565e76998942ae12a3854b9664d7d7a6b3284b180cdfc358d6fcf9b6fd2` | `ef4b603c70a6b1ea16e8be4e1f45bb300da7cb83cc1a9be1e2da2a638dbbbfe2` | 2026-10-13T12:09:38.150Z |
| 4 | **beacon** | `9e8df7bd4d60e621d8fe766e406132b8d40ebe12e43cf032894fe2bdac7db523896f08a3c4c9951cf9314710ea54699f629c22ffcd2ae6d9545bdc09def308cc` | `8256e8c10cace964eac5d66cdcc616f082e3428de2dc967468ce463b0fd467ec` | 2026-10-13T12:14:42.318Z |

Beacon: REHEARSAL fixed test value (not a real beacon). Value `7665796c2072656865617273616c3a206120666978656420746573742076616c75652c206e6f742061207265616c20626561636f6e`, hashed 2^10 times.

| result | sha256 |
|---|---|
| zk/keys/claim_final.zkey | `8256e8c10cace964eac5d66cdcc616f082e3428de2dc967468ce463b0fd467ec` |
| zk/keys/claim_vkey.json | `3e9c098f7aa888532ceb05e13b2d3d12b9c5d25626c50315c2d1adbc8577b989` |
| programs/veyl_pool/src/vkey_claim.rs | `697c7f6341c24802744af687430c881b45b74f1fe3ad608b08b3e7da4060a7ad` |

## Verify it yourself
```bash
npm ci
b2sum <each phase-1 file above>                        # must print the hashes above
npm run ceremony -- r1cs                               # recompiles every circuit; each wasm must equal the shipped one
npm run ceremony -- verify --circuit withdraw --zkey zk/keys/withdraw_final.zkey --ptau pot16_final.ptau
npm run ceremony -- verify --circuit transact --zkey zk/keys/transact_final.zkey --ptau pot16_final.ptau
npm run ceremony -- verify --circuit position --zkey zk/keys/position_final.zkey --ptau pot16_final.ptau
npm run ceremony -- verify --circuit swap --zkey zk/keys/swap_final.zkey --ptau pot16_final.ptau
npm run ceremony -- verify --circuit claim --zkey zk/keys/claim_final.zkey --ptau pot16_final.ptau
```
`verify` recomputes each key from its r1cs and the ptau, checks every contribution and the beacon, and lists every contribution hash: each contributor finds theirs above. `npm run preflight -- --network mainnet` then checks that the verifying keys baked into `veyl_pool.so` are these.
