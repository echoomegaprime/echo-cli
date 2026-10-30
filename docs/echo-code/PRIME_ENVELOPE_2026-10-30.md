# Prime owner-response integrity repair

Prime previously treated an HTTP 2xx wrapper's JSON-string body as an empty
object. An owner refusal could therefore appear as `returned`, and a successful
asynchronous job lost its job ID. The decoder now parses bounded JSON text,
requires an object body, and runs it through the existing owner-error checks.
Malformed, missing, primitive, array and oversized bodies are refused. Object
bodies and the existing eight-iteration envelope limit retain their behavior.

`NODE_DEBUG=echo-prime` enables structured diagnostic events containing only an
event name, refusal category or byte count. Response contents are not logged.
Execution receipts retain request IDs and single-use submission behavior.

The preserved regression suite first produced 28 failures and three passes
against baseline `f94d1efc48390a8820c533428e61e76b665fc9b0`. After the repair,
all 31 focused cases and all 184 repository tests passed. Lint, TypeScript build
and scoped secret scanning also passed. The new tests exercise both decoding
and the real PrimeHub execution-state boundary.

This repair does not attach an SDK identity, activate the coding owner, or turn
the current draft composer into a connected chat. Live owner discovery on
October 30 still found no `echo.core.coding.contract` registration. CertForge's
service reported `NOT_READY` and `product_readiness_contract_invalid`, with its
readiness contract expired on October 26. Independent review and exact-source
release admission remain separate requirements. No production promotion is
claimed by these tests.
