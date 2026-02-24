import { evaluateHttpPolicy } from '../src/http-policy';

describe('HTTP Policy Module', () => {
  it('allows public HTTPS without confirmation', () => {
    const result = evaluateHttpPolicy({
      name: 'Prod',
      scheme: 'https',
      host: 'rho.example.com'
    });
    expect(result).toEqual({ allowed: true, requiresConfirm: false });
  });

  it('requires confirmation for localhost HTTP', () => {
    const result = evaluateHttpPolicy({
      name: 'Local',
      scheme: 'http',
      host: 'localhost'
    });
    expect(result.allowed).toBe(true);
    if (result.requiresConfirm) {
      expect(result.warningMessage).toMatch(/localhost/i);
    } else {
      fail('Expected confirmation for localhost');
    }
  });

  it('requires confirmation for LAN HTTP', () => {
    const result = evaluateHttpPolicy({
      name: 'Home Server',
      scheme: 'http',
      host: '192.168.1.5'
    });
    expect(result.allowed).toBe(true);
    if (result.requiresConfirm) {
      expect(result.warningMessage).toMatch(/local network address/i);
    } else {
      fail('Expected confirmation for LAN');
    }
  });

  it('requires strong warning confirmation for public HTTP', () => {
    const result = evaluateHttpPolicy({
      name: 'Insecure Prod',
      scheme: 'http',
      host: 'rho.example.com'
    });
    expect(result.allowed).toBe(true);
    if (result.requiresConfirm) {
      expect(result.warningMessage).toMatch(/public address over HTTP is highly insecure/i);
    } else {
      fail('Expected confirmation for public HTTP');
    }
  });
});
