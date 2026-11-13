# Rules reloads that do not compile

Captured from the checksum-pinned official Firestore emulator 1.21.0 (the one
firebase-tools 15.22.0 pins) with Node 24.20.0; the Java version, the jar's
and the capture script's checksums are in `fixture.json`. Run
`conformance/src/developer-tools/capture-compile-errors.mjs OUTPUT` with a
fresh directory. Only the owned loopback jar is started and stopped; no
document, consumer source or cloud project is involved. The process log and
the raw record stay alongside the generated fixture, outside this directory.

The capture reloads 120 rulesets in turn (`PUT …:securityRules`, project
`demo-firenook-compile-errors`) and keeps each status and body. One small
ruleset compiles (`baseline`); every other input makes one of the mistakes
people make in it, two of them in `two/*`, or cuts it short (`eof/*`): a stray
word at the top level, `rules_version` gone wrong, a missing or extra brace,
semicolon or parenthesis, a string left open, a bad match path, a condition
cut short, a bad function header or body, `let` misused, a misspelled
keyword, Windows line endings, non-ASCII text and a tab before the mistake.
`top/broken` is `developer-tools-coverage-v1`'s `invalid-reload` again, and
`production/*` are the five sources the production Rules API refuses in
`rules-v2/production-parse-errors.json`, sent unchanged.

A refusal is `400 INVALID_ARGUMENT` with `Error compiling rules:` and one
`L<line>:<column> <message>` line per problem, in source order; columns count
Unicode scalars from 1, an empty source is `L0:0`. The messages are the
parser's: ANTLR's own (`mismatched input 'X' expecting …`, `missing 'X' at
'Y'`, `token recognition error at: 'X'`), `Unexpected 'X'.` where ANTLR would
say `extraneous input`, and the grammar's own (`Missing conditional expression
after 'if'.`, `Missing a closing '`, `Missing 'function' body`, …). The parser
recovers and goes on, so one mistake can give several lines. A character no
token starts with is reported only when the parser reports nothing, and a
package name as a binding is not reported beside a syntax error
(`two/package-and-syntax`). Seven inputs compile, three of them with
warnings, answered as `issues`. The five production inputs are worded here as
production words them.

These are observations of one emulator version's compiler, not a grammar.
