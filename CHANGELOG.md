# Changelog

## [0.2.0](https://github.com/fx/mcp-arr/compare/v0.1.2...v0.2.0) (2026-08-28)


### Features

* **acquisition:** add normalized release search adapters ([#22](https://github.com/fx/mcp-arr/issues/22)) ([ec2d716](https://github.com/fx/mcp-arr/commit/ec2d716795f46f7c680b354c4ddc21900139189d))
* **acquisition:** add opaque release references and grab ([#27](https://github.com/fx/mcp-arr/issues/27)) ([ad8e164](https://github.com/fx/mcp-arr/commit/ad8e164ab32d55f5224197772566235a8a599b93))
* **acquisition:** implement and register arr_search_start ([#31](https://github.com/fx/mcp-arr/issues/31)) ([ad1e2e2](https://github.com/fx/mcp-arr/commit/ad1e2e2c3f551af73ae2d3a201f3d87728f508ec))
* **activity:** add bounded queue and activity readers ([#23](https://github.com/fx/mcp-arr/issues/23)) ([cc76d67](https://github.com/fx/mcp-arr/commit/cc76d673b220334e4d95568c41699ce85d437c90))
* **activity:** add Prowlarr indexer status and statistics views ([#26](https://github.com/fx/mcp-arr/issues/26)) ([e2e8deb](https://github.com/fx/mcp-arr/commit/e2e8deb4b9d4b5c2b1bb96cffbc9b128e2b3a80a))
* **activity:** add queue plan, apply, and reconciliation ([#41](https://github.com/fx/mcp-arr/issues/41)) ([8953779](https://github.com/fx/mcp-arr/commit/89537792be8937c10469228c1e0e50f2723605b5))
* **activity:** add queue references and bounded diagnosis ([#29](https://github.com/fx/mcp-arr/issues/29)) ([3046e6c](https://github.com/fx/mcp-arr/commit/3046e6c9780e56872dbe425cdcbd8c2faf728dae))
* **activity:** add typed history and blocklist mutation adapters ([#33](https://github.com/fx/mcp-arr/issues/33)) ([8a51458](https://github.com/fx/mcp-arr/commit/8a514585ff7b8c50b82a48d4dcd478148d2f479e))
* **activity:** compile typed queue transitions ([#35](https://github.com/fx/mcp-arr/issues/35)) ([fee6eb8](https://github.com/fx/mcp-arr/commit/fee6eb82f6e04c22c4a0ccbd933b3edcf66b3459))
* **activity:** register and verify arr_activity_change ([#37](https://github.com/fx/mcp-arr/issues/37)) ([ee2bf13](https://github.com/fx/mcp-arr/commit/ee2bf135881a1d9643c399d4ec82da524c6be936))
* **activity:** register and verify arr_activity_query ([#32](https://github.com/fx/mcp-arr/issues/32)) ([da87edf](https://github.com/fx/mcp-arr/commit/da87edfe84c2ae8cc1fc7f7b589246424062d356))
* **activity:** register and verify arr_queue_resolve ([#44](https://github.com/fx/mcp-arr/issues/44)) ([f1d699f](https://github.com/fx/mcp-arr/commit/f1d699f180f2aa6ed4a9a9e05c8727995e9a276e))
* **configuration:** add configuration observation foundations ([#25](https://github.com/fx/mcp-arr/issues/25)) ([e56fe5f](https://github.com/fx/mcp-arr/commit/e56fe5f5b1d7a6d1c0d483b00a6eca1804aa1e45))
* **configuration:** add provider tests and an explicit warning bypass ([#45](https://github.com/fx/mcp-arr/issues/45)) ([d7fd529](https://github.com/fx/mcp-arr/commit/d7fd5298c0f7629b74acee0827cb016904db8421))
* **configuration:** add typed desired-state patches and lossless writes ([#39](https://github.com/fx/mcp-arr/issues/39)) ([08956ae](https://github.com/fx/mcp-arr/commit/08956aea0a82f2a28305ce14991985f8775cb372))
* **configuration:** read profile and resource configuration safely ([#34](https://github.com/fx/mcp-arr/issues/34)) ([f2dd746](https://github.com/fx/mcp-arr/commit/f2dd74629babb4123358e08ecabb90af325eb59e))
* **configuration:** read provider configuration safely ([#30](https://github.com/fx/mcp-arr/issues/30)) ([8b137f5](https://github.com/fx/mcp-arr/commit/8b137f502c55d4803cd14481a6c0ccf7ebdd7e3d))
* **configuration:** register and verify the configuration tools ([#46](https://github.com/fx/mcp-arr/issues/46)) ([cc8269e](https://github.com/fx/mcp-arr/commit/cc8269e36334ab4cb60cd35a73742b8b7a65f91b))
* **configuration:** require resupplied secrets and verify an apply ([#42](https://github.com/fx/mcp-arr/issues/42)) ([56720d3](https://github.com/fx/mcp-arr/commit/56720d3fa4ba05fc7fd8031534265d6f22288c09))
* **configuration:** synchronize Prowlarr application mappings ([#43](https://github.com/fx/mcp-arr/issues/43)) ([b84e8de](https://github.com/fx/mcp-arr/commit/b84e8de42cc87760b3bc8c9380a8f2c02cb8f275))
* **http:** add redaction-preserving write support to the upstream client ([#24](https://github.com/fx/mcp-arr/issues/24)) ([b7569dd](https://github.com/fx/mcp-arr/commit/b7569dd9a88cd3f93f80c407fc92d1d4eb0c510a))
* **import:** add manual-import candidate discovery and references ([#47](https://github.com/fx/mcp-arr/issues/47)) ([0bb503a](https://github.com/fx/mcp-arr/commit/0bb503a4912ad8cd821eb00ba2c2f388bb422aa6))
* **import:** correct a mapping and validate before importing ([#48](https://github.com/fx/mcp-arr/issues/48)) ([8b2a118](https://github.com/fx/mcp-arr/commit/8b2a118f9430f7e3634a5806d1613a7281ba47d9))
* **import:** execute a validated manual import as a followable job ([#49](https://github.com/fx/mcp-arr/issues/49)) ([011b9ed](https://github.com/fx/mcp-arr/commit/011b9eda300c4fe0c4caf7e6ca91a57051862893))
* **library:** add rename preview and allowlisted path commands ([#38](https://github.com/fx/mcp-arr/issues/38)) ([2e5ab0c](https://github.com/fx/mcp-arr/commit/2e5ab0cbf699f23bb9ac47e53e9083e88e5cfaa6))
* **library:** add typed add and monitoring mutations ([#28](https://github.com/fx/mcp-arr/issues/28)) ([fcbfdb8](https://github.com/fx/mcp-arr/commit/fcbfdb81b33b485a66b1c9bf6147f5443ad71f12))
* **library:** add typed file metadata and deletion mutations ([#36](https://github.com/fx/mcp-arr/issues/36)) ([0a9f4a6](https://github.com/fx/mcp-arr/commit/0a9f4a6350a94df7b746783e6e82874587ebb98a))
* **library:** register and verify arr_library_change ([#40](https://github.com/fx/mcp-arr/issues/40)) ([3ea73b7](https://github.com/fx/mcp-arr/commit/3ea73b72f289c8cfa11db2a81a75d0a428a97802))
* **tools:** bound the capability report by default ([#21](https://github.com/fx/mcp-arr/issues/21)) ([e5da230](https://github.com/fx/mcp-arr/commit/e5da2307d8baae44a83b4f7e4ce15e41a579f71e))


### Bug Fixes

* **configuration:** observe a provider field whose value key is absent ([#51](https://github.com/fx/mcp-arr/issues/51)) ([36cd97d](https://github.com/fx/mcp-arr/commit/36cd97d0c2d231db40a8af49bc1f0db405e598ea))
* **library:** anchor calendar entries to the date inside the requested window ([#19](https://github.com/fx/mcp-arr/issues/19)) ([987eb3c](https://github.com/fx/mcp-arr/commit/987eb3c9ee6d168b13cef84d86e62a045f4916a4))
* **tools:** carry the error code and remediation into result summaries ([#18](https://github.com/fx/mcp-arr/issues/18)) ([35cf47b](https://github.com/fx/mcp-arr/commit/35cf47b1a180a2ad9c60c651c48309890123d3ed))
* **tools:** publish a flat object root so hosts stop dropping thirteen tools ([#50](https://github.com/fx/mcp-arr/issues/50)) ([98e7a82](https://github.com/fx/mcp-arr/commit/98e7a82e5ba938c99e04bb58493f54aa68bda75e))
* **tools:** publish the variant argument contract for every tool ([#17](https://github.com/fx/mcp-arr/issues/17)) ([ed03c12](https://github.com/fx/mcp-arr/commit/ed03c12d2e253be39df40385824d7bd2fe136a21))

## [0.1.2](https://github.com/fx/mcp-arr/compare/v0.1.1...v0.1.2) (2026-08-26)


### Bug Fixes

* **server:** report the package version instead of a frozen literal ([805bc15](https://github.com/fx/mcp-arr/commit/805bc15cee808f2876f275ee8db1bacae5e858dd))

## [0.1.1](https://github.com/fx/mcp-arr/compare/v0.1.0...v0.1.1) (2026-08-26)


### Documentation

* **0011:** complete npm publishing and pin the provenance decision ([cb586a5](https://github.com/fx/mcp-arr/commit/cb586a541187bcea2f97bdf6ddc1290f6bd9fa58))
