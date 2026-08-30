/**
 * QR codes carry plain text. What makes a code "a wifi code" or "a contact
 * card" is the convention the text follows. These builders produce those
 * conventions correctly, including the escaping rules that are easy to get
 * wrong by hand.
 */

export type PayloadKind =
  | 'text'
  | 'url'
  | 'wifi'
  | 'vcard'
  | 'email'
  | 'sms'
  | 'tel'
  | 'geo'
  | 'event';

export type FieldSpec = {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'url' | 'email' | 'tel' | 'number' | 'select' | 'checkbox' | 'date' | 'datetime-local';
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
};

export type PayloadSpec = {
  kind: PayloadKind;
  label: string;
  blurb: string;
  fields: FieldSpec[];
  build: (values: Record<string, string>) => string;
};

/** Escapes the characters that would otherwise end a field early. */
function escapeWifi(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

function escapeVcard(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([;,])/g, '\\$1');
}

/** iCalendar wants a compact UTC stamp, for example 20260830T140000Z. */
export function toICalStamp(local: string): string {
  if (!local) return '';
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function requireValue(values: Record<string, string>, key: string, message: string): string {
  const value = (values[key] ?? '').trim();
  if (!value) throw new Error(message);
  return value;
}

/** Adds a scheme when someone types a bare domain. */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const PAYLOADS: PayloadSpec[] = [
  {
    kind: 'url',
    label: 'Link',
    blurb: 'Opens a web address. The most common thing a QR code does.',
    fields: [
      { name: 'url', label: 'Address', type: 'url', placeholder: 'alexmerced.app', required: true, help: 'A bare domain gets https:// added for you.' },
    ],
    build: (values) => normaliseUrl(requireValue(values, 'url', 'Enter an address to link to.')),
  },
  {
    kind: 'text',
    label: 'Plain text',
    blurb: 'Any text at all. Scanners show it and offer to copy it.',
    fields: [
      { name: 'text', label: 'Text', type: 'textarea', placeholder: 'Anything you want the scanner to read', required: true },
    ],
    build: (values) => requireValue(values, 'text', 'Enter some text to encode.'),
  },
  {
    kind: 'wifi',
    label: 'Wifi',
    blurb: 'Joins a network without anyone reading a password out loud.',
    fields: [
      { name: 'ssid', label: 'Network name', type: 'text', placeholder: 'Kitchen wifi', required: true },
      {
        name: 'security', label: 'Security', type: 'select',
        options: [
          { value: 'WPA', label: 'WPA or WPA2 or WPA3' },
          { value: 'WEP', label: 'WEP' },
          { value: 'nopass', label: 'Open, no password' },
        ],
      },
      { name: 'password', label: 'Password', type: 'text', placeholder: 'The network password' },
      { name: 'hidden', label: 'This network is hidden', type: 'checkbox' },
    ],
    build: (values) => {
      const ssid = requireValue(values, 'ssid', 'Enter the network name.');
      const security = values.security || 'WPA';
      const parts = [`WIFI:T:${security}`, `S:${escapeWifi(ssid)}`];
      if (security !== 'nopass') {
        const password = requireValue(values, 'password', 'Enter the network password, or choose the open option.');
        parts.push(`P:${escapeWifi(password)}`);
      }
      if (values.hidden === 'true') parts.push('H:true');
      return `${parts.join(';')};;`;
    },
  },
  {
    kind: 'vcard',
    label: 'Contact card',
    blurb: 'Adds a person to the address book in one scan.',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', required: true },
      { name: 'lastName', label: 'Last name', type: 'text' },
      { name: 'org', label: 'Organisation', type: 'text' },
      { name: 'title', label: 'Job title', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'tel', placeholder: '+1 555 0100' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'url', label: 'Website', type: 'url' },
      { name: 'address', label: 'Address', type: 'text', placeholder: 'Street, city, region, postcode, country' },
      { name: 'note', label: 'Note', type: 'textarea' },
    ],
    build: (values) => {
      const first = requireValue(values, 'firstName', 'Enter at least a first name.');
      const last = (values.lastName ?? '').trim();
      const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
      lines.push(`N:${escapeVcard(last)};${escapeVcard(first)};;;`);
      lines.push(`FN:${escapeVcard([first, last].filter(Boolean).join(' '))}`);
      if (values.org?.trim()) lines.push(`ORG:${escapeVcard(values.org.trim())}`);
      if (values.title?.trim()) lines.push(`TITLE:${escapeVcard(values.title.trim())}`);
      if (values.phone?.trim()) lines.push(`TEL;TYPE=CELL:${values.phone.trim()}`);
      if (values.email?.trim()) lines.push(`EMAIL:${values.email.trim()}`);
      if (values.url?.trim()) lines.push(`URL:${normaliseUrl(values.url)}`);
      if (values.address?.trim()) lines.push(`ADR;TYPE=WORK:;;${escapeVcard(values.address.trim())}`);
      if (values.note?.trim()) lines.push(`NOTE:${escapeVcard(values.note.trim())}`);
      lines.push('END:VCARD');
      return lines.join('\n');
    },
  },
  {
    kind: 'email',
    label: 'Email',
    blurb: 'Opens a new message with the recipient, subject, and body filled in.',
    fields: [
      { name: 'to', label: 'To', type: 'email', required: true },
      { name: 'subject', label: 'Subject', type: 'text' },
      { name: 'body', label: 'Message', type: 'textarea' },
    ],
    build: (values) => {
      const to = requireValue(values, 'to', 'Enter an email address.');
      const query: string[] = [];
      if (values.subject?.trim()) query.push(`subject=${encodeURIComponent(values.subject.trim())}`);
      if (values.body?.trim()) query.push(`body=${encodeURIComponent(values.body.trim())}`);
      return `mailto:${to}${query.length ? `?${query.join('&')}` : ''}`;
    },
  },
  {
    kind: 'sms',
    label: 'Text message',
    blurb: 'Opens a text message to a number, with the wording ready to send.',
    fields: [
      { name: 'number', label: 'Number', type: 'tel', placeholder: '+15550100', required: true },
      { name: 'message', label: 'Message', type: 'textarea' },
    ],
    build: (values) => {
      const number = requireValue(values, 'number', 'Enter a phone number.').replace(/[^\d+]/g, '');
      const message = (values.message ?? '').trim();
      return message ? `SMSTO:${number}:${message}` : `SMSTO:${number}:`;
    },
  },
  {
    kind: 'tel',
    label: 'Phone number',
    blurb: 'Starts a call.',
    fields: [
      { name: 'number', label: 'Number', type: 'tel', placeholder: '+15550100', required: true },
    ],
    build: (values) => `tel:${requireValue(values, 'number', 'Enter a phone number.').replace(/[^\d+]/g, '')}`,
  },
  {
    kind: 'geo',
    label: 'Map pin',
    blurb: 'Drops a pin at a set of coordinates.',
    fields: [
      { name: 'lat', label: 'Latitude', type: 'text', placeholder: '40.7128', required: true },
      { name: 'lon', label: 'Longitude', type: 'text', placeholder: '-74.0060', required: true },
      { name: 'label', label: 'Place name', type: 'text', help: 'Optional. Some apps show it, some ignore it.' },
    ],
    build: (values) => {
      const lat = Number(requireValue(values, 'lat', 'Enter a latitude.'));
      const lon = Number(requireValue(values, 'lon', 'Enter a longitude.'));
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('Latitude must be a number between -90 and 90.');
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('Longitude must be a number between -180 and 180.');
      const base = `geo:${lat},${lon}`;
      return values.label?.trim() ? `${base}?q=${lat},${lon}(${encodeURIComponent(values.label.trim())})` : base;
    },
  },
  {
    kind: 'event',
    label: 'Calendar event',
    blurb: 'Adds an event to the calendar, with the time and place already set.',
    fields: [
      { name: 'summary', label: 'Event name', type: 'text', required: true },
      { name: 'start', label: 'Starts', type: 'datetime-local', required: true },
      { name: 'end', label: 'Ends', type: 'datetime-local' },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' },
    ],
    build: (values) => {
      const summary = requireValue(values, 'summary', 'Enter a name for the event.');
      const start = toICalStamp(requireValue(values, 'start', 'Enter a start time.'));
      if (!start) throw new Error('That start time could not be read.');
      const end = toICalStamp(values.end ?? '');

      const lines = ['BEGIN:VEVENT', `SUMMARY:${escapeVcard(summary)}`, `DTSTART:${start}`];
      if (end) lines.push(`DTEND:${end}`);
      if (values.location?.trim()) lines.push(`LOCATION:${escapeVcard(values.location.trim())}`);
      if (values.description?.trim()) lines.push(`DESCRIPTION:${escapeVcard(values.description.trim())}`);
      lines.push('END:VEVENT');
      return lines.join('\n');
    },
  },
];

export const payloadByKind = new Map(PAYLOADS.map((spec) => [spec.kind, spec]));

export function buildPayload(kind: PayloadKind, values: Record<string, string>): string {
  const spec = payloadByKind.get(kind);
  if (!spec) throw new Error(`"${kind}" is not a payload type Tessera knows.`);
  return spec.build(values);
}
