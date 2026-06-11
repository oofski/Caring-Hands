// Tiny app-state holder for the signed-in user and active event.

const state = {
  user: null,
  event: null,
};

const listeners = new Set();

export const store = {
  get user() { return state.user; },
  get event() { return state.event; },
  setUser(u) { state.user = u; emit(); },
  setEvent(e) { state.event = e; emit(); },
  is(role) { return state.user && state.user.role === role; },
  can(...roles) { return state.user && roles.includes(state.user.role); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function emit() {
  listeners.forEach((fn) => fn(state));
}
