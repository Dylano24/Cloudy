export function getPriorityMap() {
    return {
        none: {
            name: '⚪ NONE',
            color: '#FFFFFF',
            emoji: '⚪',
            label: 'None',
        },
        low: {
            name: '🔵 LOW',
            color: '#3498DB',
            emoji: '🔵',
            label: 'Low',
        },
        medium: {
            name: '🟡 MEDIUM',
            color: '#F1C40F',
            emoji: '🟡',
            label: 'Medium',
        },
        high: {
            name: '🔴 HIGH',
            color: '#E74C3C',
            emoji: '🔴',
            label: 'High',
        },
    };
}

export const PRIORITY_MAP = getPriorityMap();
