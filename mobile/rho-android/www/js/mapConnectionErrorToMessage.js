export function mapConnectionErrorToMessage(result) {
    let message = 'Connection failed: ';
    switch (result.type) {
        case 'NETWORK_ERROR':
            message += 'Network unreachable. Please check your connection and the profile host.';
            break;
        case 'INVALID_TOKEN':
            message += 'Invalid token. Please edit the profile and update your token.';
            break;
        case 'MALFORMED_URL':
            message += 'Malformed host/profile URL. Please check the host configuration.';
            break;
        case 'MISSING_TOKEN':
            message += 'Secure token missing. Please edit the profile and re-enter your token.';
            break;
        default:
            message += result.error;
    }
    return message;
}
