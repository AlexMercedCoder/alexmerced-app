import { describe, expect, it } from 'vitest';
import { PAYLOADS, buildPayload, normaliseUrl, toICalStamp } from './payloads';

describe('normaliseUrl', () => {
  it('adds https to a bare domain', () => {
    expect(normaliseUrl('alexmerced.app')).toBe('https://alexmerced.app');
    expect(normaliseUrl('  example.com/path ')).toBe('https://example.com/path');
  });

  it('leaves an existing scheme alone', () => {
    expect(normaliseUrl('http://example.com')).toBe('http://example.com');
    expect(normaliseUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(normaliseUrl('ftp://files.example.com')).toBe('ftp://files.example.com');
  });

  it('returns empty for empty', () => {
    expect(normaliseUrl('   ')).toBe('');
  });
});

describe('link', () => {
  it('builds a link', () => {
    expect(buildPayload('url', { url: 'alexmerced.app/tessera' })).toBe('https://alexmerced.app/tessera');
  });

  it('insists on an address', () => {
    expect(() => buildPayload('url', { url: '' })).toThrow(/Enter an address/);
  });
});

describe('wifi', () => {
  it('builds a WPA payload', () => {
    expect(buildPayload('wifi', { ssid: 'Kitchen', security: 'WPA', password: 'hunter2' }))
      .toBe('WIFI:T:WPA;S:Kitchen;P:hunter2;;');
  });

  it('omits the password for an open network', () => {
    expect(buildPayload('wifi', { ssid: 'Cafe', security: 'nopass' })).toBe('WIFI:T:nopass;S:Cafe;;');
  });

  it('marks a hidden network', () => {
    expect(buildPayload('wifi', { ssid: 'Quiet', security: 'WPA', password: 'x', hidden: 'true' }))
      .toContain(';H:true;');
  });

  it('escapes the characters that would end a field early', () => {
    const payload = buildPayload('wifi', { ssid: 'My;Net', security: 'WPA', password: 'a:b,c\\d' });
    expect(payload).toContain('S:My\\;Net');
    expect(payload).toContain('P:a\\:b\\,c\\\\d');
  });

  it('insists on a password unless the network is open', () => {
    expect(() => buildPayload('wifi', { ssid: 'Net', security: 'WPA' })).toThrow(/network password/);
  });

  it('insists on a network name', () => {
    expect(() => buildPayload('wifi', { ssid: '', security: 'nopass' })).toThrow(/network name/);
  });
});

describe('vcard', () => {
  it('builds a card with the required structure', () => {
    const card = buildPayload('vcard', { firstName: 'Alex', lastName: 'Merced', org: 'Dremio', email: 'a@example.com' });
    expect(card.startsWith('BEGIN:VCARD')).toBe(true);
    expect(card.endsWith('END:VCARD')).toBe(true);
    expect(card).toContain('VERSION:3.0');
    expect(card).toContain('N:Merced;Alex;;;');
    expect(card).toContain('FN:Alex Merced');
    expect(card).toContain('ORG:Dremio');
    expect(card).toContain('EMAIL:a@example.com');
  });

  it('leaves out fields that were not filled in', () => {
    const card = buildPayload('vcard', { firstName: 'Solo' });
    expect(card).not.toContain('ORG:');
    expect(card).not.toContain('TEL');
    expect(card).toContain('FN:Solo');
  });

  it('escapes commas, semicolons, and newlines', () => {
    const card = buildPayload('vcard', { firstName: 'A', note: 'One, two; three\nfour' });
    expect(card).toContain('NOTE:One\\, two\\; three\\nfour');
  });

  it('normalises a bare website domain', () => {
    expect(buildPayload('vcard', { firstName: 'A', url: 'example.com' })).toContain('URL:https://example.com');
  });

  it('insists on a first name', () => {
    expect(() => buildPayload('vcard', {})).toThrow(/first name/);
  });
});

describe('email', () => {
  it('builds a bare mailto', () => {
    expect(buildPayload('email', { to: 'a@example.com' })).toBe('mailto:a@example.com');
  });

  it('encodes the subject and body', () => {
    const payload = buildPayload('email', { to: 'a@example.com', subject: 'Hi there', body: 'Line one & two' });
    expect(payload).toBe('mailto:a@example.com?subject=Hi%20there&body=Line%20one%20%26%20two');
  });

  it('insists on a recipient', () => {
    expect(() => buildPayload('email', { subject: 'x' })).toThrow(/email address/);
  });
});

describe('sms and tel', () => {
  it('builds a text message', () => {
    expect(buildPayload('sms', { number: '+1 (555) 010-0', message: 'hello' })).toBe('SMSTO:+15550100:hello');
  });

  it('allows an empty message', () => {
    expect(buildPayload('sms', { number: '5550100' })).toBe('SMSTO:5550100:');
  });

  it('builds a phone number and strips formatting', () => {
    expect(buildPayload('tel', { number: '+1 (555) 010-0' })).toBe('tel:+15550100');
  });
});

describe('geo', () => {
  it('builds a plain pin', () => {
    expect(buildPayload('geo', { lat: '40.7128', lon: '-74.0060' })).toBe('geo:40.7128,-74.006');
  });

  it('adds a label when given one', () => {
    expect(buildPayload('geo', { lat: '1', lon: '2', label: 'The spot' })).toBe('geo:1,2?q=1,2(The%20spot)');
  });

  it('rejects coordinates outside the real range', () => {
    expect(() => buildPayload('geo', { lat: '95', lon: '0' })).toThrow(/between -90 and 90/);
    expect(() => buildPayload('geo', { lat: '0', lon: '200' })).toThrow(/between -180 and 180/);
    expect(() => buildPayload('geo', { lat: 'north', lon: '0' })).toThrow(/between -90 and 90/);
  });
});

describe('calendar event', () => {
  it('builds a VEVENT with a UTC stamp', () => {
    const payload = buildPayload('event', {
      summary: 'Launch',
      start: '2026-08-30T14:00:00Z',
      end: '2026-08-30T15:00:00Z',
      location: 'Somewhere; nice',
    });
    expect(payload.startsWith('BEGIN:VEVENT')).toBe(true);
    expect(payload.endsWith('END:VEVENT')).toBe(true);
    expect(payload).toContain('DTSTART:20260830T140000Z');
    expect(payload).toContain('DTEND:20260830T150000Z');
    expect(payload).toContain('LOCATION:Somewhere\\; nice');
  });

  it('leaves out the end when there is none', () => {
    const payload = buildPayload('event', { summary: 'Open ended', start: '2026-08-30T14:00:00Z' });
    expect(payload).not.toContain('DTEND');
  });

  it('insists on a name and a start', () => {
    expect(() => buildPayload('event', { start: '2026-08-30T14:00:00Z' })).toThrow(/name for the event/);
    expect(() => buildPayload('event', { summary: 'x' })).toThrow(/start time/);
  });

  it('rejects an unreadable start time', () => {
    expect(() => buildPayload('event', { summary: 'x', start: 'sometime next week' })).toThrow(/could not be read/);
  });
});

describe('toICalStamp', () => {
  it('compacts an ISO timestamp', () => {
    expect(toICalStamp('2026-01-02T03:04:05Z')).toBe('20260102T030405Z');
  });

  it('returns empty for nonsense', () => {
    expect(toICalStamp('')).toBe('');
    expect(toICalStamp('not a date')).toBe('');
  });
});

describe('the payload registry', () => {
  it('exposes nine builders, each with fields and a blurb', () => {
    expect(PAYLOADS).toHaveLength(9);
    for (const spec of PAYLOADS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.blurb.length).toBeGreaterThan(0);
      expect(spec.fields.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown kind', () => {
    expect(() => buildPayload('nope' as 'text', {})).toThrow(/not a payload type/);
  });

  it('every builder throws a readable message when given nothing', () => {
    for (const spec of PAYLOADS) {
      expect(() => spec.build({})).toThrow(/^[A-Z].*\.$/);
    }
  });
});
