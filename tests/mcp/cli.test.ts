import { describe, expect, it } from 'vitest';
import { BadConfig, loadSession, readConfig } from '../../src/cli/main.js';

describe('reading configuration from the environment', () => {
  it('falls back to sensible defaults and the fair-play profile', () => {
    const config = readConfig({});
    expect(config).toMatchObject({
      host: 'localhost',
      port: 25565,
      username: 'craftonomous',
      auth: 'offline',
    });
    expect(config.version).toBeUndefined();
    expect(config.profile.name).toBe('fair-play');
  });

  it('reads every setting it is given', () => {
    const config = readConfig({
      MINECRAFT_HOST: 'mc.example.org',
      MINECRAFT_PORT: '25566',
      MINECRAFT_USERNAME: 'scout',
      MINECRAFT_VERSION: '1.21.11',
      MINECRAFT_AUTH: 'microsoft',
      CRAFTONOMOUS_PROFILE: 'xray',
    });
    expect(config).toMatchObject({
      host: 'mc.example.org',
      port: 25566,
      username: 'scout',
      version: '1.21.11',
      auth: 'microsoft',
    });
    expect(config.profile.name).toBe('xray');
  });

  it('refuses a profile it does not know rather than silently substituting one', () => {
    expect(() => readConfig({ CRAFTONOMOUS_PROFILE: 'godmode' })).toThrow(
      BadConfig,
    );
  });

  it('refuses a port that is not a port', () => {
    expect(() => readConfig({ MINECRAFT_PORT: 'ninety' })).toThrow(BadConfig);
    expect(() => readConfig({ MINECRAFT_PORT: '70000' })).toThrow(BadConfig);
  });

  it('refuses an unknown auth mode', () => {
    expect(() => readConfig({ MINECRAFT_AUTH: 'cracked' })).toThrow(BadConfig);
  });
});

describe('loading a live body', () => {
  it('reports why there is no session instead of throwing', async () => {
    const config = readConfig({});
    const result = await loadSession(config, './no-such-bootstrap.js');
    expect(result.session).toBeUndefined();
    expect(result.reason).toContain('could not load the embodiment binding');
  });
});
