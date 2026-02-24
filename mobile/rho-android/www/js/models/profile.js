export function validateProfile(profile) {
    const errors = [];
    if (!profile.id || typeof profile.id !== 'string') {
        errors.push('id is required and must be a string');
    }
    if (!profile.name || typeof profile.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    if (profile.scheme !== 'http' && profile.scheme !== 'https') {
        errors.push('scheme must be http or https');
    }
    if (!profile.host || typeof profile.host !== 'string') {
        errors.push('host is required and must be a string');
    }
    if (typeof profile.port !== 'number' || profile.port < 1 || profile.port > 65535) {
        errors.push('port must be a valid number between 1 and 65535');
    }
    return {
        valid: errors.length === 0,
        errors
    };
}
