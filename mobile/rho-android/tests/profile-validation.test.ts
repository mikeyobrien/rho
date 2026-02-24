import { validateProfile, Profile } from '../src/models/profile';

describe('Profile Validation', () => {
  it('should validate a correct profile', () => {
    const profile: Profile = {
      id: 'test-1',
      name: 'Local Dev',
      scheme: 'http',
      host: 'localhost',
      port: 8080
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should require an id', () => {
    const profile: Partial<Profile> = {
      name: 'Local Dev',
      scheme: 'http',
      host: 'localhost',
      port: 8080
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('id is required and must be a string');
  });

  it('should require a valid scheme', () => {
    const profile: any = {
      id: 'test-1',
      name: 'Local Dev',
      scheme: 'ftp', // invalid
      host: 'localhost',
      port: 8080
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('scheme must be http or https');
  });

  it('should require a valid port', () => {
    const profile: Profile = {
      id: 'test-1',
      name: 'Local Dev',
      scheme: 'http',
      host: 'localhost',
      port: -1
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('port must be a valid number between 1 and 65535');
  });
});
