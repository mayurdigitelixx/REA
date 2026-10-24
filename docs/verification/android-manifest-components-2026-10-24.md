# Android manifest components verification, 2026-10-24

## Scope and revisions

PR #5025 adds a static component inventory to `inspect_android_package`, using
the namespace-aware decoded manifest already retained by the JADX adapter.
Activities, aliases, services, receivers and providers retain declarations,
qualified class names where established, export declarations/defaults,
permission provenance, intent actions/categories, service types, authorities
and alias targets. These facts do not establish runtime registration, class
existence, merged-manifest acceptance or APK authenticity.

The maintenance comparison pins baseline
`e3802c16491b772118ccdfa195c6b51c3a337bdd` (contributor head
`c822b00c4755e584ee081eb3e7587735b630e249` integrated with main) and candidate
`fde65b1d47c00c189e003c54ad2a2c1fc93b443a`. Both contain the feature;
this comparison checks the maintenance changes rather than estimating the
cost of answering the same question without the feature. Later main
integration is outside these measurements.

## Corrections and automated coverage

Alias target matching indexes valid spellings once for preceding activities.
It now adds a bare abbreviation only for a class directly inside the manifest
package. `sub.Target` is already a fully qualified name and cannot match
`com.example.sub.Target`; `.sub.Target` and the complete qualified name can.
The contributor had already removed repeated package expansion in
`c822b00c`; that performance correction is not attributed to this follow-up.
The existing 900 KiB package / 511 alias regression remains covered.

Older Evidence without this inventory now receives a fresh unavailable
inventory per parse. Mutating one parsed default cannot affect another parse.
Before the corrections, the new identity/default cases had 6 passes and 3
failures (two false alias matches and one shared default). Afterward all 50
component cases passed. The broader selected component/JADX/SDK-summary set
passed all 83 cases, and `npm run check:fast` passed on the measured candidate.
After integrating main `21a20306b4887ff8e6b614b6ae34a387cfbdf1d8` in
`cdc2829131045d85692cf4bbf0acb12f36f65af7`, the same 83 cases passed again.
`check:fast`, `docs:check` and test discovery (2,333 files, each once) also passed.

The parser bounds declarations and retained name/permission/authority copies
before expansion. Truncation, unknown export rules, unresolved names and
unsupported permission overrides remain explicit. The existing Android
summary includes the structured inventory and retains the complete manifest
for paging; no second inventory parser or new view implementation was added.

## Real engine and public APK

Linux x86-64, Node 24.22.1 / npm 11.16.0, existing full OpenJDK 17.0.20.1,
JADX headless MCP 0.7.1, one analysis worker, 512 MiB JVM heap and
`ActiveProcessorCount=2`. The task process family was restricted to CPUs 0/1.
The APK was read as an inert artifact and was never installed or executed.

- [Appium ApiDemos 6.0.18](https://github.com/appium/android-apidemos/releases/tag/v6.0.18),
  source revision `3e716ee04ef3390284bfab761e28da8c15c08143`, Apache-2.0:
  `ApiDemos-debug.apk`, 6,521,217 bytes, SHA-256
  `a9eecf37b26cd084855c530db81c2bb1b91f4c1b095a04f47aa7c20e2791f686`.
- [JADX headless MCP 0.7.1](https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1),
  source revision `5844800a486d2248fa949b74c9896285f5b54de2`, JAR SHA-256
  `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.

The engine reported package `io.appium.android.apis`, target SDK 33,
2,876 classes and 869 resources. The complete 152,541-code-unit manifest
produced 355 components: 331 activities, 11 services, 7 receivers, 4 providers
and 2 aliases. Component coverage was complete, with no projection limitations.
APK signature verification remained explicitly `not_performed`.

An independent Python ElementTree projection checked every component field,
declaration order, namespace attribute, class-name qualification, permission
source, export/default, intent value, authority and preceding alias target
against the retained XML on all six measured CLI tasks. It also rehashed the
APK. This oracle checks REA's projection of JADX-decoded XML; it does not
independently validate binary XML decoding or Android runtime behavior.
Interpretation was checked against Android's
[activity](https://developer.android.com/guide/topics/manifest/activity-element),
[alias](https://developer.android.com/guide/topics/manifest/activity-alias-element),
[service](https://developer.android.com/guide/topics/manifest/service-element),
[receiver](https://developer.android.com/guide/topics/manifest/receiver-element)
and [provider](https://developer.android.com/guide/topics/manifest/provider-element)
documentation.

An actual stdio MCP client launched the same engine, validated the advertised
input/output schemas with Ajv2020, checked every structured summary fact,
reconstructed the exact manifest in three 70,000-code-unit pages, made a warm
complete call, and re-read the retained summary. All normalized facts and
provenance matched CLI. Raw engine snapshots and Evidence IDs were not equated:
they truthfully retain session-specific private APK paths, Java map key order,
load duration and the commands actually run. The warm complete request does
not repeat the earlier load command. This client explicitly allowed a 64 MiB
receive buffer; default client-buffer compatibility was not established.

## Completed-task costs

Three alternating before/after pairs ran
`rea inspect-android-package <same APK> --json`. Each task launched a fresh CLI
and JVM. OS/JAR caches were already warm; cold disk and first bridge compilation
were not isolated. Full normalized results, target identity and provenance
were equal; raw per-run engine records were retained without rewriting them.

| Cost                                 | Before median (range)      | After median (range)       |
| ------------------------------------ | -------------------------- | -------------------------- |
| Estimated task tokens                | 135,958 (same in all runs) | 135,958 (same in all runs) |
| Elapsed seconds                      | 16.538 (14.666–37.511)     | 23.008 (17.756–24.777)     |
| CPU seconds                          | 18.811 (18.034–19.461)     | 18.191 (17.741–18.426)     |
| Sampled peak process-family RSS, MiB | 1,074.9 (989.7–1,087.9)    | 1,100.4 (1,074.1–1,123.6)  |

The elapsed and CPU ranges overlap; these runs establish no speed improvement.
The candidate's median sampled memory was slightly higher. Tokens use tokenx
1.3.0 estimates, not model billing: all complete CLI stdout plus the invocation
(135,926 + 32 tokens). Discovery, prompts, client parsing and envelopes are
outside this known CLI task.

The actual MCP verification task took 132.448 seconds, 40.767 CPU seconds and
1,820.8 MiB sampled peak family RSS, including handshake, full discovery,
schema validation, summary, three manifest pages, complete call, retained
summary and shutdown. An earlier verification attempt used an incorrect
cross-session raw-Evidence equality assertion and failed after 36.131 seconds;
that diagnostic attempt is not counted as a successful workflow.

For the successful MCP task, compact JSON payloads estimate 47,583 tokens for
the summary versus 135,759 for the warm complete Evidence. These are individual
payload estimates, not a measured whole-agent saving; the 222-tool discovery,
envelopes, repeated text/structured representations and earlier attempt are
not included in that payload comparison. CLI and MCP transports have different
costs and are not interchangeable baselines.

CPU comes from waited child-process accounting. RSS samples descendants every
50 ms, may count shared pages more than once and may miss short-lived children;
it is not a kernel-enforced process-family maximum. No Android device,
split APK, signature-verification, native-library or runtime coverage is claimed.
Issue #4448's broader enabled/process, metadata, URI-grant and location requests
remain open.

## SDK omission and XML namespace follow-up

The subsequent review fixes are pinned in
`dfdba0fac79e07949b12299c85a1a2f3e9c2f115`.
Android's [uses-sdk contract](https://developer.android.com/guide/topics/manifest/uses-sdk-element)
defaults an omitted target to the minimum SDK and an omitted minimum to 1.
The component XML owner now combines the bridge's declaration values with
attribute-presence facts from the already parsed document. A present-empty
attribute or an unrecognized nonempty value stays unknown. Declaration-level
`target_sdk` and `min_sdk` remain unchanged. Root child nodes are reused, and
the effective numeric SDK/provider default is computed once; the redundant
per-provider parsing helper was removed.

One unnamespaced-element predicate now guards the manifest root, uses-sdk,
application, components, filters, actions and categories. Foreign lookalikes
cannot contribute component facts or satisfy an alias's preceding target.
Namespace URIs on Android attributes continue to govern attribute selection.

Eleven new negative cases fail on the published baseline, with three positive
SDK cases already passing. Three further present-empty SDK cases fail with a
simple string fallback and pass with the owned presence facts. Unknown-SDK
fixtures now supply an explicit unrecognized value rather than using omission
to mean unknown. All 100 selected component/JADX/protocol/SDK-summary cases
pass, as do `check:fast`, `format:check`, `docs:check` and discovery of all
2,333 files. Complete inventory coverage does not establish every SDK or
export state; nullable facts and limitations retain that uncertainty.

Another three alternating public-APK pairs compare published
`b50ee503fdff0912c12f1aaa76f043235d187a77` with the corrected revision above.
Every normalized fact/provenance field and all 355 component rows match the
independent oracle again. The exact-raw-record exclusions and fresh-JVM,
warm-OS-cache conditions described above apply.

| Cost                               | Before median (range)   | After median (range)      |
| ---------------------------------- | ----------------------- | ------------------------- |
| Estimated complete CLI task tokens | 135,958 (constant)      | 135,958 (constant)        |
| Elapsed seconds                    | 12.036 (11.133–12.487)  | 11.024 (10.623–17.519)    |
| CPU seconds                        | 18.436 (18.169–18.897)  | 17.921 (17.252–19.856)    |
| Sampled peak family RSS, MiB       | 1,022.1 (981.3–1,049.8) | 1,043.8 (1,023.5–1,090.1) |

The ranges overlap and sampled memory median is higher; no speed or memory
improvement is established by this comparison. The actual stdio MCP workflow
also passes again, including all summary facts, the three manifest pages,
warm complete inspection and retained summary. That completed verification
took 26.991 seconds, 35.482 CPU seconds and 1,740.9 MiB sampled peak family RSS.
Its schema/client-buffer and comparison qualifications above remain in force.
These legacy-SDK edge cases are production-boundary/golden checks; the real
APK has an explicit SDK 33 target, so a legacy APK without uses-sdk was not
independently exercised through binary XML decoding or on a device.

## DEX names and hexadecimal SDK follow-up

Commit `27b7dc1656b66a71796d6f0d1119d79be7ab586a` corrects two additional
interpretation boundaries. Class identity expansion accepts the documented
[DEX SimpleName character ranges](https://source.android.com/docs/core/runtime/dex-format#simplename),
including leading digits, hyphens and supplemental Unicode, instead of Java
source identifier categories. The same predicate supplies activity and alias
reference matching. Package declaration validation remains separate. Spaces
are admitted by the character union introduced in DEX 040; this decoded
manifest projection does not establish a DEX version, class existence or
runtime loadability.

SDK interpretation now accepts decimal or hexadecimal positive signed-32-bit
resource integers once per inventory. [JADX's typed value decoder](https://github.com/skylot/jadx/blob/v1.5.3/jadx-core/src/main/java/jadx/core/xmlgen/entry/ValuesParser.java#L84)
prints `TYPE_INT_HEX` with a hexadecimal prefix. The unchanged Java bridge
retains those declaration strings; only the local numeric interpretation used
for default rules changes. Unrecognized previews, malformed hex, exponent
syntax, nonpositive values and signed-int overflow remain unknown. Omission
and present-empty handling from the prior correction remains intact.

Nine new controls fail before the correction: four legal DEX name/alias
combinations, three hexadecimal target levels, hexadecimal minimum fallback,
and decimal signed-int overflow. The former malformed-name fixture incorrectly
rejected a digit-led class; it now uses forbidden descriptor separators
instead. The component/MCP selection passes 77 checks. `check:fast`, complete
formatting and documentation pass. The first combined 117-case selection has
116 passes and one 30-second MCP timeout; the unchanged MCP file then passes
all three cases in isolation, with its complete retained-manifest workflow
finishing in 16.957 seconds. That workflow supplies a 1 MiB non-XML string;
the changed class and SDK interpreters are not reached for that input. No
deadline was raised. Further combined verification is recorded below.

Six alternating completed CLI tasks compare the immediately preceding head
`58b71c19b35204ebb37c94d9510025bcd18fc4ee` with this correction using the
unchanged ApiDemos APK. Every projected field for all 355 components matches
the independent decoded-XML oracle, and all normalized facts and provenance
agree. Per-session raw engine observations and their Evidence IDs are excluded
for the same documented reason as the previous comparison. Estimated full CLI
stdout plus invocation tokens remain **135,958** (tokenx 1.3.0).

Elapsed medians are 19.619 -> 17.893 s (ranges 12.708–23.907 /
13.658–30.088), waited CPU 30.279 -> 29.507 s (19.684–32.572 /
24.001–37.071), and sampled process-family RSS 1094.6 -> 1064.9 MiB
(985.0–1106.2 / 1038.3–1108.5). Every range overlaps; the environment varies
substantially and these runs establish no speed or memory improvement. CLI
and JVM processes are fresh, with warm OS/JAR caches; cold-disk and fresh
bridge-compilation costs remain unmeasured. The actual stdio SDK workflow also
passes summary, three manifest pages, warm complete output, retained summary
and advertised-schema validation again: 72.614 s elapsed, 78.638 s CPU and
1693.3 MiB sampled family RSS. Its full schema/catalog/transport token cost is
not measured. That workflow validates the existing APK's explicit SDK 33
values; no binary-XML hex fixture or numeric-led DEX class was executed or
qualified on a device. The new edge cases are boundary controls supported by
the format/decoder sources, not claims of real-device coverage.

The subsequent unchanged full selection passes **all 117 cases** in 67.186 s
elapsed, 52.269 s waited CPU and 2028.3 MiB sampled family RSS. This rerun
does not erase the earlier timeout recorded above.
