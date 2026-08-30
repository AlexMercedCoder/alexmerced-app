/**
 * The value generators.
 *
 * Everything draws from a seeded generator, so the same schema and seed
 * produce the same rows every time. That is the whole point: sample data you
 * cannot reproduce is no use for a demo you want to run twice.
 */
import { Rng } from '../../lib/random';

const FIRST_NAMES = [
  'Alex', 'Sam', 'Priya', 'Jordan', 'Ravi', 'Mei', 'Noor', 'Diego', 'Ines', 'Tomas',
  'Aisha', 'Yusuf', 'Lena', 'Marco', 'Sofia', 'Kwame', 'Hana', 'Oliver', 'Zara', 'Ana',
  'Felix', 'Nadia', 'Idris', 'Clara', 'Bruno', 'Leila', 'Kenji', 'Rosa', 'Milan', 'Astrid',
];

const LAST_NAMES = [
  'Merced', 'Okafor', 'Nakamura', 'Silva', 'Haddad', 'Novak', 'Fernandez', 'Kaur', 'Lindqvist',
  'Duarte', 'Petrov', 'Osei', 'Rossi', 'Mbeki', 'Larsen', 'Costa', 'Ahmed', 'Yilmaz', 'Moreau',
  'Kovacs', 'Bianchi', 'Reyes', 'Traore', 'Sorensen', 'Villanueva', 'Andersson', 'Chowdhury',
];

const CITIES = [
  'Lisbon', 'Nairobi', 'Osaka', 'Bogota', 'Helsinki', 'Marrakesh', 'Vancouver', 'Dublin',
  'Seoul', 'Valparaiso', 'Tallinn', 'Accra', 'Wellington', 'Porto', 'Ljubljana', 'Montreal',
  'Reykjavik', 'Cape Town', 'Bergen', 'Kyoto', 'Cusco', 'Antwerp', 'Riga', 'Hobart',
];

const COUNTRIES = [
  'Portugal', 'Kenya', 'Japan', 'Colombia', 'Finland', 'Morocco', 'Canada', 'Ireland',
  'South Korea', 'Chile', 'Estonia', 'Ghana', 'New Zealand', 'Slovenia', 'Iceland', 'South Africa',
];

const STREETS = ['Oak', 'Harbour', 'Mill', 'Chapel', 'Garden', 'Kings', 'Market', 'Elm', 'Bridge', 'Cedar', 'Vine', 'Station'];
const STREET_TYPES = ['Street', 'Road', 'Lane', 'Avenue', 'Way', 'Close'];

const COMPANY_PREFIX = ['North', 'Blue', 'Iron', 'Bright', 'Cedar', 'Anchor', 'Quiet', 'Field', 'Stone', 'River'];
const COMPANY_SUFFIX = ['Works', 'Labs', 'Systems', 'Collective', 'Partners', 'Supply', 'Foundry', 'Group', 'Studio'];

const DOMAINS = ['example.com', 'example.org', 'example.net', 'test.example', 'mail.example'];

const WORDS = [
  'lakehouse', 'catalog', 'schema', 'partition', 'ingest', 'stream', 'batch', 'query', 'index',
  'metric', 'pipeline', 'cluster', 'archive', 'snapshot', 'manifest', 'column', 'record', 'table',
  'signal', 'threshold', 'window', 'lineage', 'contract', 'governance', 'retention',
];

const PRODUCTS = ['Widget', 'Sprocket', 'Gasket', 'Bracket', 'Coupler', 'Valve', 'Bearing', 'Flange', 'Spindle', 'Bushing'];
const STATUSES = ['active', 'pending', 'suspended', 'closed'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];

export type FieldKind =
  | 'id' | 'uuid' | 'sequence'
  | 'firstName' | 'lastName' | 'fullName' | 'email' | 'username' | 'phone'
  | 'company' | 'jobTitle'
  | 'street' | 'city' | 'country' | 'postcode' | 'latitude' | 'longitude'
  | 'integer' | 'decimal' | 'money' | 'boolean' | 'percent'
  | 'date' | 'datetime' | 'time'
  | 'sentence' | 'paragraph' | 'word' | 'slug'
  | 'url' | 'ipv4' | 'macAddress' | 'hexColor' | 'currency' | 'status' | 'product'
  | 'enum' | 'foreignKey' | 'constant';

export type Field = {
  id: string;
  name: string;
  kind: FieldKind;
  /** Chance the value is null, 0 to 1. */
  nullRate: number;
  min?: number;
  max?: number;
  decimals?: number;
  /** For enum, a comma separated list. For constant, the value. */
  options?: string;
  /** For foreignKey, the table it points at. */
  references?: string;
  unique?: boolean;
};

export type Table = {
  id: string;
  name: string;
  rows: number;
  fields: Field[];
};

export const FIELD_KINDS: { id: FieldKind; label: string; group: string }[] = [
  { id: 'id', label: 'ID (sequential)', group: 'Keys' },
  { id: 'uuid', label: 'UUID', group: 'Keys' },
  { id: 'foreignKey', label: 'Foreign key', group: 'Keys' },
  { id: 'firstName', label: 'First name', group: 'People' },
  { id: 'lastName', label: 'Last name', group: 'People' },
  { id: 'fullName', label: 'Full name', group: 'People' },
  { id: 'email', label: 'Email', group: 'People' },
  { id: 'username', label: 'Username', group: 'People' },
  { id: 'phone', label: 'Phone', group: 'People' },
  { id: 'jobTitle', label: 'Job title', group: 'People' },
  { id: 'company', label: 'Company', group: 'Places' },
  { id: 'street', label: 'Street address', group: 'Places' },
  { id: 'city', label: 'City', group: 'Places' },
  { id: 'country', label: 'Country', group: 'Places' },
  { id: 'postcode', label: 'Postcode', group: 'Places' },
  { id: 'latitude', label: 'Latitude', group: 'Places' },
  { id: 'longitude', label: 'Longitude', group: 'Places' },
  { id: 'integer', label: 'Integer', group: 'Numbers' },
  { id: 'decimal', label: 'Decimal', group: 'Numbers' },
  { id: 'money', label: 'Money', group: 'Numbers' },
  { id: 'percent', label: 'Percent', group: 'Numbers' },
  { id: 'boolean', label: 'Boolean', group: 'Numbers' },
  { id: 'date', label: 'Date', group: 'Time' },
  { id: 'datetime', label: 'Timestamp', group: 'Time' },
  { id: 'time', label: 'Time of day', group: 'Time' },
  { id: 'word', label: 'Word', group: 'Text' },
  { id: 'slug', label: 'Slug', group: 'Text' },
  { id: 'sentence', label: 'Sentence', group: 'Text' },
  { id: 'paragraph', label: 'Paragraph', group: 'Text' },
  { id: 'enum', label: 'One of a list', group: 'Text' },
  { id: 'constant', label: 'Always the same', group: 'Text' },
  { id: 'status', label: 'Status', group: 'Text' },
  { id: 'product', label: 'Product name', group: 'Text' },
  { id: 'currency', label: 'Currency code', group: 'Text' },
  { id: 'url', label: 'URL', group: 'Technical' },
  { id: 'ipv4', label: 'IPv4 address', group: 'Technical' },
  { id: 'macAddress', label: 'MAC address', group: 'Technical' },
  { id: 'hexColor', label: 'Hex colour', group: 'Technical' },
];

export type Value = string | number | boolean | null;

export type GenerateContext = {
  rng: Rng;
  rowIndex: number;
  /** Keys already generated for other tables, for foreign keys to draw from. */
  keys: Map<string, Value[]>;
};

const pad = (value: number, size: number) => String(value).padStart(size, '0');
const padHex = (value: number, size: number) => value.toString(16).padStart(size, '0');

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function generateValue(field: Field, context: GenerateContext): Value {
  const { rng, rowIndex } = context;

  if (field.nullRate > 0 && rng.next() < field.nullRate) return null;

  const min = field.min ?? 0;
  const max = field.max ?? 100;

  switch (field.kind) {
    case 'id':
    case 'sequence':
      return rowIndex + 1;

    case 'uuid': {
      const hex = '0123456789abcdef';
      let out = '';
      for (let i = 0; i < 32; i += 1) out += hex[rng.int(0, 15)];
      return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`;
    }

    case 'foreignKey': {
      const pool = context.keys.get(field.references ?? '') ?? [];
      return pool.length ? rng.pick(pool) : null;
    }

    case 'firstName': return rng.pick(FIRST_NAMES);
    case 'lastName': return rng.pick(LAST_NAMES);
    case 'fullName': return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;

    case 'email': {
      const first = rng.pick(FIRST_NAMES).toLowerCase();
      const last = rng.pick(LAST_NAMES).toLowerCase();
      const style = rng.int(0, 2);
      const local = style === 0 ? `${first}.${last}` : style === 1 ? `${first}${rng.int(1, 99)}` : `${first[0]}${last}`;
      return `${local}@${rng.pick(DOMAINS)}`;
    }

    case 'username': return `${rng.pick(FIRST_NAMES).toLowerCase()}_${rng.pick(WORDS)}${rng.int(1, 99)}`;
    case 'phone': return `+1-${rng.int(200, 999)}-${pad(rng.int(0, 999), 3)}-${pad(rng.int(0, 9999), 4)}`;
    case 'jobTitle': {
      const level = rng.pick(['Junior', 'Senior', 'Lead', 'Principal', 'Staff', '']);
      const role = rng.pick(['Engineer', 'Analyst', 'Designer', 'Manager', 'Architect', 'Scientist']);
      return `${level ? `${level} ` : ''}Data ${role}`.replace('Data Manager', 'Engineering Manager');
    }

    case 'company': return `${rng.pick(COMPANY_PREFIX)}${rng.pick(COMPANY_SUFFIX)}`;
    case 'street': return `${rng.int(1, 999)} ${rng.pick(STREETS)} ${rng.pick(STREET_TYPES)}`;
    case 'city': return rng.pick(CITIES);
    case 'country': return rng.pick(COUNTRIES);
    case 'postcode': return `${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))}${rng.int(1, 99)} ${rng.int(1, 9)}${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))}`;
    case 'latitude': return rng.float(-90, 90, 6);
    case 'longitude': return rng.float(-180, 180, 6);

    case 'integer': return rng.int(Math.round(min), Math.round(max));
    case 'decimal': return rng.float(min, max, field.decimals ?? 2);
    case 'money': return rng.float(min || 1, max || 5000, 2);
    case 'percent': return rng.float(0, 100, field.decimals ?? 1);
    case 'boolean': return rng.bool();

    case 'date': {
      const from = new Date(field.min ?? Date.UTC(2020, 0, 1));
      const to = new Date(field.max ?? Date.UTC(2026, 11, 31));
      return rng.date(from, to).toISOString().slice(0, 10);
    }
    case 'datetime': {
      const from = new Date(field.min ?? Date.UTC(2020, 0, 1));
      const to = new Date(field.max ?? Date.UTC(2026, 11, 31));
      return `${rng.date(from, to).toISOString().slice(0, 19)}Z`;
    }
    case 'time': return `${pad(rng.int(0, 23), 2)}:${pad(rng.int(0, 59), 2)}:${pad(rng.int(0, 59), 2)}`;

    case 'word': return rng.pick(WORDS);
    case 'slug': return slugify(`${rng.pick(WORDS)} ${rng.pick(WORDS)} ${rng.int(1, 999)}`);
    case 'sentence': {
      const length = rng.int(5, 12);
      const words = Array.from({ length }, () => rng.pick(WORDS));
      return `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}.`;
    }
    case 'paragraph': {
      const sentences = rng.int(2, 4);
      return Array.from({ length: sentences }, () => {
        const words = Array.from({ length: rng.int(6, 14) }, () => rng.pick(WORDS));
        return `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}.`;
      }).join(' ');
    }

    case 'url': return `https://${rng.pick(COMPANY_PREFIX).toLowerCase()}${rng.pick(COMPANY_SUFFIX).toLowerCase()}.example/${slugify(rng.pick(WORDS))}`;
    case 'ipv4': return `${rng.int(1, 223)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
    case 'macAddress': return Array.from({ length: 6 }, () => padHex(rng.int(0, 255), 2)).join(':');
    case 'hexColor': return `#${padHex(rng.int(0, 0xffffff), 6)}`;
    case 'currency': return rng.pick(CURRENCIES);
    case 'status': return rng.pick(STATUSES);
    case 'product': return `${rng.pick(PRODUCTS)} ${String.fromCharCode(65 + rng.int(0, 25))}${rng.int(100, 999)}`;

    case 'enum': {
      const options = (field.options ?? '').split(',').map((option) => option.trim()).filter(Boolean);
      return options.length ? rng.pick(options) : null;
    }
    case 'constant':
      return field.options ?? '';

    default:
      return null;
  }
}

/** Which kinds produce values suitable to reference from another table. */
export function isKeyKind(kind: FieldKind): boolean {
  return kind === 'id' || kind === 'uuid' || kind === 'sequence';
}
