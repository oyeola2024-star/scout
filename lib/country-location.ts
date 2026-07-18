export type CountryBusinessLike = {
  location?: unknown;
  raw?: unknown;
  domain?: unknown;
  website?: unknown;
  email?: unknown;
};

const REGION_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AR","AS","AT","AU","AW","AX","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GT","GU","GW","GY","HK","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ","TC","TD","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","YT","ZA","ZM","ZW"
];

const displayNames = (() => {
  try {
    const intl = (Intl as unknown as {
      DisplayNames?: new (
        locales: string[],
        options: { type: string },
      ) => { of(code: string): string | undefined };
    }).DisplayNames;
    return intl ? new intl(["en"], { type: "region" }) : null;
  } catch {
    return null;
  }
})();

const COUNTRY_BY_CODE = new Map<string, string>();
for (const code of REGION_CODES) {
  const name = displayNames?.of(code) || code;
  COUNTRY_BY_CODE.set(code.toLowerCase(), name);
}
COUNTRY_BY_CODE.set("uk", "United Kingdom");
COUNTRY_BY_CODE.set("gb", "United Kingdom");
COUNTRY_BY_CODE.set("kr", "South Korea");
COUNTRY_BY_CODE.set("kp", "North Korea");
COUNTRY_BY_CODE.set("cz", "Czechia");

const EXTRA_ALIASES: Record<string, string> = {
  usa: "United States",
  "u.s.a": "United States",
  "u.s.a.": "United States",
  us: "United States",
  "u.s.": "United States",
  america: "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  "great britain": "United Kingdom",
  britain: "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  "northern ireland": "United Kingdom",
  uae: "United Arab Emirates",
  "u.a.e.": "United Arab Emirates",
  emirates: "United Arab Emirates",
  "south korea": "South Korea",
  "republic of korea": "South Korea",
  "north korea": "North Korea",
  russia: "Russia",
  "czech republic": "Czechia",
  "ivory coast": "Côte d’Ivoire",
  "cote d ivoire": "Côte d’Ivoire",
  "viet nam": "Vietnam",
  "hong kong": "Hong Kong",
  macau: "Macao",
};

const COUNTRY_FIELD_KEYWORDS = ["country", "nation"];
const LOCATION_FIELD_KEYWORDS = [
  "location",
  "market",
  "city",
  "region",
  "state",
  "province",
  "address",
  "territory",
  "headquarter",
  "hq",
];

function normalizeForMatch(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const COUNTRY_NAMES = new Map<string, string>();
for (const country of COUNTRY_BY_CODE.values()) {
  COUNTRY_NAMES.set(normalizeForMatch(country), country);
}
for (const [alias, country] of Object.entries(EXTRA_ALIASES)) {
  COUNTRY_NAMES.set(normalizeForMatch(alias), country);
}

const CITY_TO_COUNTRY: Record<string, string> = {
  berlin: "Germany",
  munich: "Germany",
  hamburg: "Germany",
  frankfurt: "Germany",
  cologne: "Germany",
  dusseldorf: "Germany",
  stuttgart: "Germany",
  paris: "France",
  lyon: "France",
  marseille: "France",
  madrid: "Spain",
  barcelona: "Spain",
  valencia: "Spain",
  rome: "Italy",
  milan: "Italy",
  naples: "Italy",
  amsterdam: "Netherlands",
  rotterdam: "Netherlands",
  brussels: "Belgium",
  antwerp: "Belgium",
  london: "United Kingdom",
  manchester: "United Kingdom",
  birmingham: "United Kingdom",
  glasgow: "United Kingdom",
  dublin: "Ireland",
  cork: "Ireland",
  zurich: "Switzerland",
  geneva: "Switzerland",
  vienna: "Austria",
  salzburg: "Austria",
  stockholm: "Sweden",
  gothenburg: "Sweden",
  oslo: "Norway",
  copenhagen: "Denmark",
  helsinki: "Finland",
  warsaw: "Poland",
  krakow: "Poland",
  prague: "Czechia",
  lisbon: "Portugal",
  porto: "Portugal",
  athens: "Greece",
  istanbul: "Turkey",
  ankara: "Turkey",
  dubai: "United Arab Emirates",
  "abu dhabi": "United Arab Emirates",
  doha: "Qatar",
  riyadh: "Saudi Arabia",
  jeddah: "Saudi Arabia",
  "kuwait city": "Kuwait",
  cairo: "Egypt",
  alexandria: "Egypt",
  lagos: "Nigeria",
  abuja: "Nigeria",
  accra: "Ghana",
  nairobi: "Kenya",
  johannesburg: "South Africa",
  "cape town": "South Africa",
  "new york": "United States",
  "los angeles": "United States",
  chicago: "United States",
  "san francisco": "United States",
  houston: "United States",
  miami: "United States",
  toronto: "Canada",
  vancouver: "Canada",
  montreal: "Canada",
  ottawa: "Canada",
  calgary: "Canada",
  edmonton: "Canada",
  halifax: "Canada",
  winnipeg: "Canada",
  victoria: "Canada",
  saskatoon: "Canada",
  regina: "Canada",
  quebec: "Canada",
  mississauga: "Canada",
  hamilton: "Canada",
  laval: "Canada",
  oakville: "Canada",
  sydney: "Australia",
  melbourne: "Australia",
  brisbane: "Australia",
  perth: "Australia",
  auckland: "New Zealand",
  wellington: "New Zealand",
  singapore: "Singapore",
  "kuala lumpur": "Malaysia",
  bangkok: "Thailand",
  manila: "Philippines",
  jakarta: "Indonesia",
  hanoi: "Vietnam",
  "ho chi minh": "Vietnam",
  tokyo: "Japan",
  osaka: "Japan",
  seoul: "South Korea",
  beijing: "China",
  shanghai: "China",
  shenzhen: "China",
  "hong kong": "Hong Kong",
  mumbai: "India",
  delhi: "India",
  bengaluru: "India",
  bangalore: "India",
  pune: "India",
  "mexico city": "Mexico",
  "sao paulo": "Brazil",
  "rio de janeiro": "Brazil",
  "buenos aires": "Argentina",
  santiago: "Chile",
};

const CANADIAN_PROVINCES: Record<string, string> = {
  ab: "Canada",
  alberta: "Canada",
  bc: "Canada",
  "british columbia": "Canada",
  mb: "Canada",
  manitoba: "Canada",
  nb: "Canada",
  "new brunswick": "Canada",
  nl: "Canada",
  "newfoundland and labrador": "Canada",
  ns: "Canada",
  "nova scotia": "Canada",
  nt: "Canada",
  "northwest territories": "Canada",
  nu: "Canada",
  nunavut: "Canada",
  on: "Canada",
  ontario: "Canada",
  pe: "Canada",
  "prince edward island": "Canada",
  qc: "Canada",
  quebec: "Canada",
  sk: "Canada",
  saskatchewan: "Canada",
  yt: "Canada",
  yukon: "Canada",
};

const US_STATE_CODES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

const STRONG_COUNTRY_TLDS = new Set([
  "at","au","be","br","ca","ch","cl","cn","cz","de","dk","es","fi","fr","gr","hk","id","ie","il","in","it","jp","kr","mx","my","ng","nl","no","nz","ph","pk","pl","pt","ro","ru","se","sg","sk","th","tr","tw","ua","uk","us","vn","za",
]);

function cleanPotentialLocation(value: unknown) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length > 500) return "";
  const lower = cleaned.toLowerCase();
  if (lower.includes("@")) return "";
  if (lower.startsWith("http")) return "";
  if (lower.includes("www.")) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) return "";
  return cleaned;
}

function matchesWord(haystack: string, needle: string) {
  if (!needle) return false;
  return new RegExp(
    `(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
    "i",
  ).test(haystack);
}

function countryFromAddressPattern(value: unknown) {
  const cleaned = cleanPotentialLocation(value);
  if (!cleaned) return "";
  const normalized = normalizeForMatch(cleaned);

  // Canadian postal codes are strong enough to classify even when the word
  // Canada is omitted from the uploaded address.
  if (/\b[abceghj-nprstvxy]\d[abceghj-nprstvwxyz][ -]?\d[abceghj-nprstvwxyz]\d\b/i.test(cleaned)) {
    return "Canada";
  }

  for (const [province, country] of Object.entries(CANADIAN_PROVINCES)) {
    if (province.length > 2 && matchesWord(normalized, normalizeForMatch(province))) {
      return country;
    }
  }

  // Two-letter Canadian province codes are only accepted when the text looks
  // like an address, avoiding false matches such as the ordinary word "on".
  if (/\d/.test(cleaned) || cleaned.includes(",")) {
    for (const province of Object.keys(CANADIAN_PROVINCES).filter((item) => item.length === 2)) {
      if (new RegExp(`(?:^|[,\\s])${province}(?:[,\\s]|$)`, "i").test(cleaned)) {
        return "Canada";
      }
    }
  }

  const usZip = /\b\d{5}(?:-\d{4})?\b/.test(cleaned);
  if (usZip) {
    const tokens = normalized.split(" ");
    if (tokens.some((token) => US_STATE_CODES.has(token))) return "United States";
  }

  return "";
}

function countryFromText(value: unknown, key = "") {
  const cleaned = cleanPotentialLocation(value);
  if (!cleaned) return "";
  const normalized = normalizeForMatch(cleaned);
  const normalizedKey = normalizeForMatch(key);

  const isAddressLikeKey =
    normalizedKey.includes("city") ||
    normalizedKey.includes("location") ||
    normalizedKey.includes("address") ||
    normalizedKey.includes("market") ||
    normalizedKey.includes("state") ||
    normalizedKey.includes("province");

  if (isAddressLikeKey) {
    const addressCountry = countryFromAddressPattern(cleaned);
    if (addressCountry) return addressCountry;
  }

  if (/^[a-z]{2}$/i.test(cleaned.trim())) {
    const code = cleaned.trim().toLowerCase();
    if (isAddressLikeKey && CANADIAN_PROVINCES[code]) return "Canada";
    const fromCode = COUNTRY_BY_CODE.get(code);
    if (fromCode) return fromCode;
  }

  const exact = COUNTRY_NAMES.get(normalized);
  if (exact) return exact;

  const rawCommaParts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  for (let index = rawCommaParts.length - 1; index >= 0; index -= 1) {
    const rawPart = rawCommaParts[index];
    const part = normalizeForMatch(rawPart);
    const country = COUNTRY_NAMES.get(part);
    if (country) return country;
    if (/^[a-z]{2}$/i.test(part)) {
      if (
        isAddressLikeKey &&
        CANADIAN_PROVINCES[part] &&
        rawPart === rawPart.toUpperCase()
      ) {
        return "Canada";
      }
      const codeCountry = COUNTRY_BY_CODE.get(part);
      if (codeCountry) return codeCountry;
    }
  }

  for (const [alias, country] of COUNTRY_NAMES.entries()) {
    if (alias.length >= 4 && matchesWord(normalized, alias)) return country;
  }

  if (isAddressLikeKey) {
    for (const [city, country] of Object.entries(CITY_TO_COUNTRY)) {
      if (matchesWord(normalized, normalizeForMatch(city))) return country;
    }
  }

  return "";
}

function hostFromUnknown(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  const candidate = text.includes("@") ? text.split("@").pop() || "" : text;
  try {
    return new URL(candidate.startsWith("http") ? candidate : `https://${candidate}`)
      .hostname
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return candidate
      .replace(/^https?:\/\//, "")
      .split(/[/?#]/)[0]
      .replace(/^www\./, "")
      .replace(/:\d+$/, "");
  }
}

function countryFromDomain(...values: unknown[]) {
  for (const value of values) {
    const host = hostFromUnknown(value);
    if (!host || !host.includes(".")) continue;
    const labels = host.split(".").filter(Boolean);
    const tld = labels.at(-1) || "";
    if (!STRONG_COUNTRY_TLDS.has(tld)) continue;
    const country = COUNTRY_BY_CODE.get(tld);
    if (country) return country;
  }
  return "";
}

function rawRecord(raw: unknown) {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function resolveBusinessCountry(business: CountryBusinessLike) {
  const raw = rawRecord(business.raw);

  // 1. Explicit uploaded country/nation columns always win.
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeForMatch(key);
    if (!COUNTRY_FIELD_KEYWORDS.some((keyword) => normalizedKey.includes(keyword))) continue;
    const country = countryFromText(value, key);
    if (country) return country;
  }

  // 2. The normalized Scout location column.
  const directLocation = countryFromText(business.location, "location");
  if (directLocation) return directLocation;

  // 3. Uploaded address/city/state/province/market values retained in raw JSON.
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeForMatch(key);
    if (!LOCATION_FIELD_KEYWORDS.some((keyword) => normalizedKey.includes(keyword))) continue;
    const country = countryFromText(value, key);
    if (country) return country;
  }

  // 4. Country-code domain is a fallback, never stronger than an address.
  return countryFromDomain(
    business.domain,
    business.website,
    raw.domain,
    raw.website,
    raw.url,
  );
}

export function extractBusinessCountries(business: CountryBusinessLike) {
  const country = resolveBusinessCountry(business);
  return country ? [country] : [];
}

export function businessMatchesCountry(
  business: CountryBusinessLike,
  selectedCountry: string,
) {
  const selected = countryFromText(selectedCountry, "country") || selectedCountry.trim();
  if (!selected) return true;
  const resolved = resolveBusinessCountry(business);
  return resolved.toLowerCase() === selected.toLowerCase();
}

export function applyCountryFilter<T extends CountryBusinessLike>(
  rows: T[],
  selectedCountry: string,
) {
  const selected = countryFromText(selectedCountry, "country") || selectedCountry.trim();
  if (!selected) return rows;
  return rows.filter((row) => businessMatchesCountry(row, selected));
}
