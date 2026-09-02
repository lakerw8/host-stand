#!/usr/bin/env node
// Finds a run code whose scenario guarantees the demo beats before 7:30 PM:
// an A-category, a B-category, and the D1 request on parties arriving between
// 6:15 and 7:15; the E3 injection probe on a walk-in arriving while a
// reservation is arriving; and a kitchen delay around 7:00. Run codes are
// seeds, so `New run` can load the code verbatim.
import { createInitialState } from "../src/engine.js";
import { minutesToTime } from "../src/data.js";

const WINDOW = [18 * 60 + 15, 19 * 60 + 15];
const wanted = Number(process.argv[2] || 1);
const limit = Number(process.argv[3] || 50000);
const partyMinute = (party) => (party.source === "reservation" ? party.reservedFor : party.arrivedAt);
const inWindow = (minute) => minute >= WINDOW[0] && minute <= WINDOW[1];

function describe(state) {
  const requests = state.parties.filter((party) => party.request).map((party) => ({ party, request: party.request }));
  const probe = requests.find(({ request }) => request.template === "E3");
  const arrivals = state.events.filter((event) => event.type === "arrival");
  const probeArrival = probe && arrivals.find((event) => event.partyIds.includes(probe.party.id));
  const reservationArrivals = arrivals.filter((event) => event.partyIds.some((id) => state.parties.find((party) => party.id === id)?.source === "reservation"));
  const delay = state.events.find((event) => event.type === "kitchen_delay");
  return {
    aRequest: requests.find(({ party, request }) => request.category === "A" && inWindow(partyMinute(party))),
    bRequest: requests.find(({ party, request }) => request.category === "B" && inWindow(partyMinute(party))),
    d1Request: requests.find(({ party, request }) => request.template === "D1" && inWindow(partyMinute(party))),
    probe,
    probeArrival,
    probeMeetsReservation: Boolean(probeArrival
      && probeArrival.minute <= 19 * 60 + 30
      && reservationArrivals.some((event) => event.minute >= probeArrival.minute - 2 && event.minute <= probeArrival.minute)),
    delay,
    delayOnTime: Boolean(delay && delay.minute >= 18 * 60 + 50 && delay.minute <= 19 * 60 + 10),
    requests
  };
}

function qualifies(summary) {
  return summary.aRequest && summary.bRequest && summary.d1Request && summary.probeMeetsReservation && summary.delayOnTime;
}

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeFor = (index) => {
  let value = index;
  let suffix = "";
  for (let position = 0; position < 4; position += 1) {
    suffix = alphabet[value % alphabet.length] + suffix;
    value = Math.floor(value / alphabet.length);
  }
  return `DEMO${suffix}`;
};

let found = 0;
for (let index = 0; index < limit && found < wanted; index += 1) {
  const code = codeFor(index);
  const state = createInitialState({ scenarioSeed: code, randomizeScenario: true });
  if (state.runCode !== code) throw new Error(`run code ${state.runCode} does not round-trip seed ${code}`);
  const summary = describe(state);
  if (!qualifies(summary)) continue;
  found += 1;
  console.log(`RUN CODE ${code}`);
  console.log(`  parties ${state.parties.length} · requests ${summary.requests.length + state.sectionRequests.length}`);
  for (const { party, request } of summary.requests.sort((left, right) => partyMinute(left.party) - partyMinute(right.party))) {
    console.log(`  ${minutesToTime(partyMinute(party)).padStart(8)}  ${request.template}  ${party.name} (${party.size}, ${party.source}, ${request.source})  “${request.text}”`);
  }
  for (const request of state.sectionRequests) console.log(`  section   ${request.template}  ${request.zone}  “${request.text}”`);
  console.log(`  E3 walk-in arrives ${minutesToTime(summary.probeArrival.minute)} alongside a reservation arrival`);
  console.log(`  kitchen delay ${minutesToTime(summary.delay.minute)} → ${minutesToTime(summary.delay.until)}`);
}
if (!found) {
  console.error(`No qualifying seed in ${limit} candidates.`);
  process.exit(1);
}
