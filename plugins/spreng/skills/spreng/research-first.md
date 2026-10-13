## 2a. Research before each ad task

Tell the user which saved research and angles you are checking or collecting. Read the selected client's
`get_client` research, angle, offer and brand sections and all `get_records` payload parts. Call
`get_workflow(clientId)` for source tasks and state. Reuse suitable saved work; missing or stale work is
part of the ad request, not a separate permission question. Use the customer's browser connector,
built-in browser, search or web fetch for missing sources. The optional local collectors are not required.
Work systematically through the workflow's sourceCollectionPlan, covering all 15 app sources on a
best-effort basis. Note each failed or blocked source, try an available fallback and continue to the
next source. Continue with available evidence and offer facts through saved research, saved angles
and ad preparation even when some sources could not complete.

Save collected evidence and failed/blocked/skipped receipts with `save_record(kind: research)` and read
it back. Keep one complete bundle and all its `researchRecordIds`, including every split part, through
structure → verify → decide_message → mechanism → product → offer → stack → buyer_read → angles.
Complete only missing or stale stages; reuse published outputs and resume existing runs. Claim, submit
and publish each stage before its dependents. A client with suitable research but no angles needs the
native angles stage. Then select saved plates/angles and prepare the ads. The host answers the existing
methods; a model name in a claim is not an instruction to call a paid API.

If the user explicitly opts out, save their choice as a notes record and take the offer-only route
(`angles` with `mode: offer_only`). An inaccessible source gets a receipt and the host continues with
available evidence. This sequence is host guidance. The server enforces access, selection, claims,
publication and the existing saved-angle requirement; it does not enforce research quality or every
source succeeding. No fresh host report is presented as the app's Gemini deep-research/decode method.

