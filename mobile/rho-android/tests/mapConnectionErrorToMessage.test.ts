import { mapConnectionErrorToMessage } from '../src/mapConnectionErrorToMessage';

describe('mapConnectionErrorToMessage', () => {
  it('maps NETWORK_ERROR to network unreachable message', () => {
    const result = { type: 'NETWORK_ERROR', error: 'some generic message' };
    const msg = mapConnectionErrorToMessage(result);
    expect(msg).toBe('Connection failed: Network unreachable. Please check your connection and the profile host.');
  });

  it('maps INVALID_TOKEN to invalid token message', () => {
    const result = { type: 'INVALID_TOKEN', error: 'some generic message' };
    const msg = mapConnectionErrorToMessage(result);
    expect(msg).toBe('Connection failed: Invalid token. Please edit the profile and update your token.');
  });

  it('maps MALFORMED_URL to malformed URL message', () => {
    const result = { type: 'MALFORMED_URL', error: 'some generic message' };
    const msg = mapConnectionErrorToMessage(result);
    expect(msg).toBe('Connection failed: Malformed host/profile URL. Please check the host configuration.');
  });

  it('maps MISSING_TOKEN to missing token message', () => {
    const result = { type: 'MISSING_TOKEN', error: 'some generic message' };
    const msg = mapConnectionErrorToMessage(result);
    expect(msg).toBe('Connection failed: Secure token missing. Please edit the profile and re-enter your token.');
  });
  
  it('maps unknown type to default message with error details', () => {
    const result = { type: 'UNKNOWN_ERROR', error: 'Unexpected fail' };
    const msg = mapConnectionErrorToMessage(result);
    expect(msg).toBe('Connection failed: Unexpected fail');
  });
});
