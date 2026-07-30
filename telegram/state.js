const userState = new Map();

function setState(userId, stateData) {
    userState.set(userId, { ...userState.get(userId), ...stateData });
}

function getState(userId) {
    return userState.get(userId) || {};
}

function clearState(userId) {
    userState.delete(userId);
}

module.exports = { setState, getState, clearState };
