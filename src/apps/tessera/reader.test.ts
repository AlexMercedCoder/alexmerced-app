import { describe, expect, it } from 'vitest';
import { describePayload, fitToScan } from './reader';

describe('describePayload', () => {
  it('recognises a web address and offers it as a link', () => {
    const reading = describePayload('https://example.com/page');
    expect(reading.kind).toBe('Web address');
    expect(reading.link).toBe('https://example.com/page');
    expect(reading.caution).toBeNull();
  });

  it('recognises an email address', () => {
    const reading = describePayload('mailto:someone@example.com');
    expect(reading.kind).toBe('Email address');
    expect(reading.link).toBe('mailto:someone@example.com');
  });

  it('describes a phone number without making it clickable', () => {
    const reading = describePayload('tel:+15551234567');
    expect(reading.kind).toBe('Phone number');
    expect(reading.link).toBeNull();
  });

  it('warns about a Wi-Fi code rather than joining anything', () => {
    const reading = describePayload('WIFI:T:WPA;S:CoffeeShop;P:hunter2;;');
    expect(reading.kind).toBe('Wi-Fi network');
    expect(reading.link).toBeNull();
    expect(reading.caution).toMatch(/wireless network/);
  });

  it('warns that a two factor secret should not be shared', () => {
    const reading = describePayload('otpauth://totp/Example:me?secret=ABCDEF');
    expect(reading.kind).toBe('Two factor secret');
    expect(reading.caution).toMatch(/Do not share/);
    expect(reading.link).toBeNull();
  });

  it('warns about a payment request and never links it', () => {
    const reading = describePayload('bitcoin:bc1qexampleaddress?amount=0.5');
    expect(reading.kind).toBe('Payment request');
    expect(reading.link).toBeNull();
    expect(reading.caution).toMatch(/request for money/);
  });

  it('recognises a contact card and a calendar event', () => {
    expect(describePayload('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD').kind).toBe('Contact card');
    expect(describePayload('BEGIN:VEVENT\nEND:VEVENT').kind).toBe('Calendar event');
  });

  it('refuses to link a scheme that could hand off to another app', () => {
    const reading = describePayload('myapp://do-something?token=abc');
    expect(reading.link).toBeNull();
    expect(reading.caution).toMatch(/another app/);
  });

  it('refuses to link javascript, whatever it claims to be', () => {
    const reading = describePayload('javascript:alert(1)');
    expect(reading.link).toBeNull();
  });

  it('flags a punycode hostname, which can imitate a familiar name', () => {
    const reading = describePayload('https://xn--80ak6aa92e.com/login');
    expect(reading.link).not.toBeNull();
    expect(reading.caution).toMatch(/non-Latin characters/);
  });

  it('treats plain text as plain text', () => {
    expect(describePayload('just some words').kind).toBe('Plain text');
    expect(describePayload('just some words').link).toBeNull();
  });

  it('recognises a bare number', () => {
    expect(describePayload('0123456789').kind).toBe('Number');
  });

  it('ignores surrounding whitespace', () => {
    expect(describePayload('   https://example.com  ').kind).toBe('Web address');
  });
});

describe('fitToScan', () => {
  it('leaves a small image alone', () => {
    expect(fitToScan(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('shrinks a large one on its longest edge', () => {
    expect(fitToScan(4000, 3000, 1400)).toEqual({ width: 1400, height: 1050 });
  });

  it('shrinks a portrait image on its height', () => {
    expect(fitToScan(3000, 4000, 1400)).toEqual({ width: 1050, height: 1400 });
  });

  it('never returns a zero dimension', () => {
    expect(fitToScan(1, 10000, 10).height).toBeGreaterThan(0);
    expect(fitToScan(1, 10000, 10).width).toBeGreaterThan(0);
  });
});
