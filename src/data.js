export const SERVICE_START = 17 * 60;
export const SERVICE_END = 22 * 60;
export const FIRST_SEATING = SERVICE_START + 15;
export const EXPECTED_DWELL_MINUTES = 90;

export const PREFERENCE_KEYS = ["view", "quiet", "away_kitchen", "counter", "booth", "private", "round", "together"];

export const SERVER_SECTIONS = Object.freeze({
  view: Object.freeze({ server: "Mia", label: "window section" }),
  interior: Object.freeze({ server: "Jordan", label: "main dining section" }),
  kitchen: Object.freeze({ server: "Alex", label: "south section" })
});

const table = (id, seats, minSeats, shape, zone, options = {}) => ({
  id,
  seats,
  minSeats,
  shape,
  zone,
  quiet: false,
  nearKitchen: zone === "kitchen",
  highChair: true,
  accessible: false,
  notes: "",
  layout: { column: 1, row: 1, columnSpan: 1, rowSpan: 1 },
  ...options
});

export const TABLE_DEFINITIONS = [
  table("V1", 2, 1, "square", "view", { notes: "Window 2-top", layout: { column: 2, row: 1, columnSpan: 1, rowSpan: 1 } }),
  table("V2", 2, 1, "square", "view", { layout: { column: 4, row: 1, columnSpan: 1, rowSpan: 1 } }),
  table("V3", 4, 2, "square", "view", { accessible: true, layout: { column: 6, row: 1, columnSpan: 2, rowSpan: 1 } }),
  table("V4", 4, 2, "square", "view", { layout: { column: 8, row: 1, columnSpan: 2, rowSpan: 1 } }),
  table("V5", 6, 4, "round", "view", { notes: "Window round", layout: { column: 10, row: 1, columnSpan: 2, rowSpan: 1 } }),
  table("V6", 4, 2, "square", "view", { notes: "Window 4-top", layout: { column: 12, row: 1, columnSpan: 2, rowSpan: 1 } }),
  table("D1", 4, 2, "square", "interior", { notes: "North dining row", layout: { column: 3, row: 2, columnSpan: 2, rowSpan: 1 } }),
  table("D2", 2, 1, "square", "interior", { layout: { column: 5, row: 2, columnSpan: 1, rowSpan: 1 } }),
  table("D3", 2, 1, "square", "interior", { accessible: true, layout: { column: 6, row: 2, columnSpan: 1, rowSpan: 1 } }),
  table("D4", 4, 2, "square", "interior", { notes: "North dining row", layout: { column: 7, row: 2, columnSpan: 2, rowSpan: 1 } }),
  table("B1", 4, 2, "booth", "interior", { quiet: true, layout: { column: 3, row: 3, columnSpan: 2, rowSpan: 1 } }),
  table("B2", 4, 2, "booth", "interior", { quiet: true, layout: { column: 3, row: 5, columnSpan: 2, rowSpan: 1 } }),
  table("B3", 4, 2, "booth", "interior", { quiet: true, highChair: false, notes: "Tight booth", layout: { column: 5, row: 3, columnSpan: 2, rowSpan: 1 } }),
  table("B4", 2, 1, "booth", "interior", { quiet: true, highChair: false, layout: { column: 5, row: 5, columnSpan: 1, rowSpan: 1 } }),
  table("B5", 4, 2, "booth", "interior", { quiet: true, layout: { column: 5, row: 6, columnSpan: 2, rowSpan: 1 } }),
  table("R1", 6, 4, "round", "interior", { notes: "Center round", layout: { column: 7, row: 3, columnSpan: 2, rowSpan: 2 } }),
  table("R2", 8, 6, "round", "interior", { notes: "Center large", layout: { column: 7, row: 5, columnSpan: 2, rowSpan: 2 } }),
  table("D5", 4, 2, "square", "interior", { notes: "East dining row", layout: { column: 9, row: 4, columnSpan: 2, rowSpan: 1 } }),
  table("D6", 4, 2, "square", "interior", { notes: "East dining row", layout: { column: 9, row: 5, columnSpan: 2, rowSpan: 1 } }),
  table("S1", 4, 2, "square", "interior", { accessible: true, layout: { column: 3, row: 7, columnSpan: 2, rowSpan: 1 } }),
  table("S2", 4, 2, "square", "interior", { layout: { column: 5, row: 7, columnSpan: 2, rowSpan: 1 } }),
  table("S3", 4, 2, "square", "kitchen", { layout: { column: 7, row: 7, columnSpan: 2, rowSpan: 1 } }),
  table("S4", 2, 1, "square", "kitchen", { layout: { column: 9, row: 7, columnSpan: 1, rowSpan: 1 } }),
  table("S5", 2, 1, "square", "kitchen", { highChair: false, layout: { column: 10, row: 7, columnSpan: 1, rowSpan: 1 } }),
  table("S6", 4, 2, "square", "kitchen", { accessible: true, notes: "South extension", layout: { column: 11, row: 7, columnSpan: 2, rowSpan: 1 } }),
  table("C1", 2, 1, "counter", "counter", { highChair: false, accessible: true, layout: { column: 1, row: 2, columnSpan: 1, rowSpan: 1 } }),
  table("C2", 2, 1, "counter", "counter", { highChair: false, layout: { column: 1, row: 3, columnSpan: 1, rowSpan: 1 } }),
  table("C3", 2, 1, "counter", "counter", { highChair: false, layout: { column: 1, row: 4, columnSpan: 1, rowSpan: 1 } }),
  table("C4", 2, 1, "counter", "counter", { highChair: false, layout: { column: 1, row: 5, columnSpan: 1, rowSpan: 1 } }),
  table("C5", 2, 1, "counter", "counter", { highChair: false, layout: { column: 1, row: 6, columnSpan: 1, rowSpan: 1 } }),
  table("C6", 2, 1, "counter", "counter", { highChair: false, layout: { column: 1, row: 7, columnSpan: 1, rowSpan: 1 } }),
  table("P1", 8, 5, "private", "private", { quiet: true, accessible: true, notes: "Private room", layout: { column: 11, row: 3, columnSpan: 3, rowSpan: 2 } }),
  table("P2", 6, 5, "private", "private", { quiet: true, notes: "Private room", layout: { column: 11, row: 5, columnSpan: 3, rowSpan: 2 } })
];

export const RESTAURANT_CAPACITY = TABLE_DEFINITIONS.reduce((total, definition) => total + definition.seats, 0);
export const TABLE_UNIT_COUNT = TABLE_DEFINITIONS.length;

const reservation = (id, name, size, reservedFor, preferences = [], options = {}) => ({
  id,
  name,
  size,
  source: "reservation",
  reservedFor,
  arrivedAt: null,
  preferences,
  children: 0,
  needsAccessible: false,
  isRegular: false,
  quotedWaitMin: null,
  notes: "",
  ...options
});

const walkIn = (id, name, size, arrivedAt, preferences = [], options = {}) => ({
  id,
  name,
  size,
  source: "walk_in",
  reservedFor: null,
  arrivedAt,
  preferences,
  children: 0,
  needsAccessible: false,
  isRegular: false,
  quotedWaitMin: null,
  notes: "",
  ...options
});

export const PARTY_DEFINITIONS = [
  reservation("patel", "Patel", 2, FIRST_SEATING, [], { isRegular: true, notes: "Anniversary" }),
  reservation("nguyen", "Nguyen", 4, FIRST_SEATING, []),
  reservation("alvarez", "Alvarez", 6, FIRST_SEATING + 15, []),
  reservation("haddad", "Haddad", 4, FIRST_SEATING + 20, [], { children: 2, notes: "Two children · high chair required" }),
  reservation("brooks", "Brooks", 2, FIRST_SEATING + 30, []),
  reservation("singh", "Singh", 4, FIRST_SEATING + 45, []),
  reservation("okonkwo", "Okonkwo", 8, FIRST_SEATING + 60, [], { notes: "Birthday" }),
  reservation("cohen", "Cohen", 3, FIRST_SEATING + 75, []),
  reservation("park", "Park", 5, FIRST_SEATING + 90, []),
  reservation("rossi", "Rossi", 4, FIRST_SEATING + 120),
  walkIn("diaz", "Diaz", 6, FIRST_SEATING + 8),
  walkIn("lee", "Lee", 2, FIRST_SEATING + 12),
  walkIn("chen", "Chen", 4, FIRST_SEATING + 22, [], { isRegular: true }),
  walkIn("walsh", "Walsh", 8, FIRST_SEATING + 41),
  walkIn("tanaka", "Tanaka", 2, FIRST_SEATING + 85),
  walkIn("morgan", "Morgan", 4, FIRST_SEATING + 100),
  walkIn("rojas", "Rojas", 3, FIRST_SEATING + 125)
];

function seededRandom(seed) {
  let value = 2166136261;
  for (const character of String(seed)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

const PARTY_NAME_POOL = [
  "Patel", "Nguyen", "Alvarez", "Haddad", "Brooks", "Singh", "Okonkwo", "Cohen",
  "Park", "Rossi", "Diaz", "Lee", "Chen", "Walsh", "Tanaka", "Morgan", "Rojas",
  "Bennett", "Ibrahim", "Kim", "Martinez", "Nakamura", "Osei", "Petrov", "Reed",
  "Santos", "Thompson", "Usman", "Vega", "Williams", "Xu", "Young", "Anderson",
  "Bianchi", "Costa", "Das", "Evans", "Flores", "Garcia", "Hassan", "Ito",
  "Johnson", "Kowalski", "Laurent", "Mensah", "Novak", "Ortiz", "Price", "Quinn",
  "Rahman", "Silva", "Torres", "Ueda", "Vasquez", "Wang", "Yilmaz", "Zhang",
  "Adeyemi", "Brown", "Clarke", "Dubois", "Esposito", "Foster", "Green", "Hoffman",
  "Jensen", "Khan", "Lopez", "Murphy", "Ndlovu", "Owens", "Pereira", "Robinson",
  "Schmidt", "Taylor", "Underwood", "Valdez", "White", "Yamamoto", "Zuniga", "Bailey",
  "Campbell", "Desai", "Ellis", "Fernandez", "Gupta", "Harris", "Inoue", "Jackson",
  "Kaur", "Liu", "Mendez", "Nelson", "Olsen", "Popov", "Rivera", "Shah",
  "Turner", "Velasquez", "Walker", "Yoon", "Zhao", "Ahmed", "Baker", "Choi",
  "Dlamini", "Edwards", "Franco", "Ghosh", "Huang"
];

export const PARTY_SIZE_DISTRIBUTION = Object.freeze([
  Object.freeze({ size: 1, weight: 6 }),
  Object.freeze({ size: 2, weight: 48 }),
  Object.freeze({ size: 3, weight: 10 }),
  Object.freeze({ size: 4, weight: 24 }),
  Object.freeze({ size: 5, weight: 4 }),
  Object.freeze({ size: 6, weight: 5 }),
  Object.freeze({ size: 8, weight: 3 })
]);
const OCCASION_POOL = ["", "", "", "Anniversary", "Birthday", "Business dinner", "First visit"];

const randomInt = (random, minimum, maximum) => minimum + Math.floor(random() * (maximum - minimum + 1));
const randomFrom = (random, values) => values[Math.floor(random() * values.length)];
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function normalizedPartySizeRoster(partyCount, random) {
  const allocations = PARTY_SIZE_DISTRIBUTION.map(({ size, weight }) => {
    const exactCount = partyCount * weight / 100;
    return {
      size,
      count: Math.floor(exactCount),
      remainder: exactCount - Math.floor(exactCount),
      tieBreaker: random()
    };
  });
  const assignedCount = allocations.reduce((total, allocation) => total + allocation.count, 0);
  const remainingCount = partyCount - assignedCount;

  allocations
    .sort((left, right) => right.remainder - left.remainder || left.tieBreaker - right.tieBreaker)
    .slice(0, remainingCount)
    .forEach((allocation) => { allocation.count += 1; });

  return shuffle(
    allocations.flatMap(({ size, count }) => Array(count).fill(size)),
    random
  );
}

function groupScenarioEvents(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.minute}:${event.type}`;
    const existing = grouped.get(key);
    if (existing && event.partyIds) existing.partyIds.push(...event.partyIds);
    else grouped.set(key, { ...event, ...(event.partyIds ? { partyIds: [...event.partyIds] } : {}) });
  }
  return [...grouped.values()].sort((left, right) => left.minute - right.minute || left.type.localeCompare(right.type));
}

function weightedServiceSlots(start, end, step, weightForMinute) {
  const slots = [];
  for (let minute = start; minute <= end; minute += step) {
    slots.push(...Array(weightForMinute(minute)).fill(minute));
  }
  return slots;
}

function dinnerRushWeight(minute, offPeakWeight = 1) {
  if (minute >= 19 * 60 && minute < 20 * 60) return 5;
  if (minute >= 18 * 60 && minute < 21 * 60) return 4;
  if (minute >= FIRST_SEATING && minute < 18 * 60) return 2;
  return offPeakWeight;
}

export function createNightParties(seed = "host-stand-saturday") {
  const random = seededRandom(seed);
  const parties = PARTY_DEFINITIONS.map((party) => ({ ...party, preferences: [] }));
  const partyOrder = shuffle(parties.map((_, index) => index), random);

  partyOrder.forEach((partyIndex, orderIndex) => {
    const preferenceCount = orderIndex % 4;
    parties[partyIndex].preferences = shuffle(PREFERENCE_KEYS, random).slice(0, preferenceCount);
  });
  return parties;
}

export function createServiceBrief(parties, seed = "host-stand-brief", options = {}) {
  const random = seededRandom(seed);
  const excludedPartyIds = new Set(options.excludedPartyIds || []);
  const sectionEntries = Object.entries(SERVER_SECTIONS);
  const [zone, section] = randomFrom(random, sectionEntries);
  const overloadFrom = randomInt(random, 18 * 60, 20 * 60 + 15);
  const roundedFrom = Math.round(overloadFrom / 5) * 5;
  const overloadUntil = Math.min(SERVICE_END, roundedFrom + randomFrom(random, [30, 35, 40, 45]));
  const reservations = parties
    .filter((party) => party.source === "reservation" && !excludedPartyIds.has(party.id) && party.size <= 6)
    .sort((left, right) => left.reservedFor - right.reservedFor);
  const possiblePairs = [];
  for (let leftIndex = 0; leftIndex < reservations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < reservations.length; rightIndex += 1) {
      const left = reservations[leftIndex];
      const right = reservations[rightIndex];
      if (Math.abs(left.reservedFor - right.reservedFor) <= 60) possiblePairs.push([left, right]);
    }
  }
  const [nearbyLeft, nearbyRight] = randomFrom(random, possiblePairs.length ? possiblePairs : [[reservations[0], reservations[1]]]);

  return {
    title: "Tonight’s seating brief",
    directives: [
      {
        id: "section-load",
        type: "section_load",
        priority: "soft",
        zone,
        server: section.server,
        sectionLabel: section.label,
        from: roundedFrom,
        until: overloadUntil,
        text: `Server ${section.server}’s ${section.label} is overloaded from ${minutesToTime(roundedFrom)} to ${minutesToTime(overloadUntil)}. Avoid adding parties there unless it protects a hard constraint.`
      },
      {
        id: "nearby-parties",
        type: "party_proximity",
        priority: "soft",
        partyIds: [nearbyLeft.id, nearbyRight.id],
        partyNames: [nearbyLeft.name, nearbyRight.name],
        maxTableDistance: 3,
        text: `The ${nearbyLeft.name} & ${nearbyRight.name} parties would like nearby tables. Keep them within roughly three floor-grid units when practical.`
      }
    ]
  };
}

export function createRandomNightScenario(seed = `night-${Date.now()}`) {
  const random = seededRandom(seed);
  const partyCount = randomInt(random, 84, 96);
  const reservationCount = randomInt(
    random,
    Math.floor(partyCount * 0.6),
    Math.floor(partyCount * 0.68)
  );
  const names = shuffle(PARTY_NAME_POOL, random).slice(0, partyCount);
  const partySizes = normalizedPartySizeRoster(partyCount, random);
  const preferenceCounts = shuffle(Array.from({ length: partyCount }, (_, index) => index % 4), random);
  const reservationSlots = shuffle(
    weightedServiceSlots(FIRST_SEATING, 21 * 60 + 30, 15, dinnerRushWeight),
    random
  ).slice(0, reservationCount).sort((left, right) => left - right);
  const walkInCount = partyCount - reservationCount;
  const walkInSlots = shuffle(
    weightedServiceSlots(FIRST_SEATING + 5, 21 * 60 + 40, 5, (minute) => (
      Math.max(1, dinnerRushWeight(minute) - 1)
    )),
    random
  ).slice(0, walkInCount).sort((left, right) => left - right);

  let reservationIndex = 0;
  let walkInIndex = 0;
  const sourceOrder = shuffle([
    ...Array(reservationCount).fill("reservation"),
    ...Array(walkInCount).fill("walk_in")
  ], random);

  const parties = names.map((name, index) => {
    const source = sourceOrder[index];
    const size = partySizes[index];
    const preferences = shuffle(PREFERENCE_KEYS, random).slice(0, preferenceCounts[index]);
    const reservedFor = source === "reservation" ? reservationSlots[reservationIndex++] : null;
    const arrivedAt = source === "walk_in" ? walkInSlots[walkInIndex++] : null;
    const children = size >= 2 && random() < 0.16 ? randomInt(random, 1, Math.min(2, size - 1)) : 0;
    const needsAccessible = random() < 0.1;
    const occasion = randomFrom(random, OCCASION_POOL);
    return {
      id: `${slugify(name)}-${index + 1}`,
      name,
      size,
      source,
      reservedFor,
      arrivedAt,
      preferences,
      children,
      needsAccessible,
      isRegular: random() < 0.16,
      quotedWaitMin: null,
      notes: children ? `${children} ${children === 1 ? "child" : "children"} · high chair required` : occasion
    };
  });

  // Every generated run includes at least one hard-constraint party so an agent
  // is tested on legality, not only ranking easy assignments.
  if (!parties.some((party) => party.children)) {
    const party = randomFrom(random, parties.filter((candidate) => candidate.size >= 2));
    party.children = 1;
    party.notes = "One child · high chair required";
  }
  if (!parties.some((party) => party.needsAccessible)) {
    randomFrom(random, parties).needsAccessible = true;
  }

  const reservations = parties.filter((party) => party.source === "reservation");
  const noShowCount = randomInt(random, 0, Math.min(2, reservations.length));
  const noShowIds = new Set(shuffle(reservations.map((party) => party.id), random).slice(0, noShowCount));
  const events = [];

  for (const party of parties) {
    if (party.source === "walk_in") {
      events.push({ minute: party.arrivedAt, type: "arrival", partyIds: [party.id] });
      continue;
    }
    if (noShowIds.has(party.id)) {
      events.push({ minute: Math.min(SERVICE_END - 1, party.reservedFor + randomInt(random, 15, 25)), type: "no_show", partyIds: [party.id] });
      continue;
    }
    const arrivalMinute = Math.max(FIRST_SEATING, Math.min(SERVICE_END - 1, party.reservedFor + randomInt(random, -4, 10)));
    events.push({ minute: arrivalMinute, type: "arrival", partyIds: [party.id] });
  }

  if (random() < 0.7) {
    const delayStart = randomInt(random, FIRST_SEATING + 35, FIRST_SEATING + 105);
    events.push({ minute: delayStart, type: "kitchen_delay", until: delayStart + randomInt(random, 10, 25) });
  }

  return {
    parties,
    events: groupScenarioEvents(events),
    serviceBrief: createServiceBrief(parties, `${seed}-brief`, { excludedPartyIds: [...noShowIds] }),
    seed: String(seed),
    runCode: String(seed).replaceAll("-", "").slice(-8).toUpperCase()
  };
}

export const SCRIPTED_EVENTS = [
  { minute: FIRST_SEATING, type: "arrival", partyIds: ["patel", "nguyen"] },
  { minute: FIRST_SEATING + 8, type: "arrival", partyIds: ["diaz"] },
  { minute: FIRST_SEATING + 12, type: "arrival", partyIds: ["lee"] },
  { minute: FIRST_SEATING + 18, type: "arrival", partyIds: ["haddad"] },
  { minute: FIRST_SEATING + 22, type: "arrival", partyIds: ["chen"] },
  { minute: FIRST_SEATING + 30, type: "arrival", partyIds: ["brooks"] },
  { minute: FIRST_SEATING + 45, type: "arrival", partyIds: ["singh"] },
  { minute: FIRST_SEATING + 50, type: "no_show", partyIds: ["alvarez"] },
  { minute: FIRST_SEATING + 60, type: "arrival", partyIds: ["okonkwo"] },
  { minute: FIRST_SEATING + 65, type: "kitchen_delay", until: FIRST_SEATING + 80 },
  { minute: FIRST_SEATING + 75, type: "arrival", partyIds: ["cohen"] },
  { minute: FIRST_SEATING + 85, type: "arrival", partyIds: ["tanaka"] },
  { minute: FIRST_SEATING + 90, type: "arrival", partyIds: ["park"] },
  { minute: FIRST_SEATING + 100, type: "arrival", partyIds: ["morgan"] },
  { minute: FIRST_SEATING + 120, type: "arrival", partyIds: ["rossi"] },
  { minute: FIRST_SEATING + 125, type: "arrival", partyIds: ["rojas"] }
];

export const PREFERENCE_LABELS = {
  view: "View",
  quiet: "Quiet",
  away_kitchen: "Away from kitchen",
  counter: "Counter",
  booth: "Booth",
  private: "Private",
  round: "Round",
  together: "Together"
};

export const minutesToTime = (minute) => {
  const wrapped = ((Math.round(minute) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour24 = Math.floor(wrapped / 60);
  const minutePart = wrapped % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minutePart).padStart(2, "0")} ${suffix}`;
};

export const parseTime = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3]?.toLowerCase();
  if (minute > 59 || hour > 23) return null;
  if (suffix) {
    if (hour > 12 || hour === 0) return null;
    hour = hour % 12 + (suffix === "pm" ? 12 : 0);
  }
  return hour * 60 + minute;
};
