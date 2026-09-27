// Navigation state for the pivots, with a back stack like Zune's back arrow.
import { Emitter } from './util.js';

class Router extends Emitter {
  state = { pivot: 'collection', sub: 'music', view: 'artists', params: {} };
  stack = [];

  go(next, { replace = false } = {}) {
    const merged = { ...this.state, params: {}, ...next };
    if (JSON.stringify(merged) === JSON.stringify(this.state)) return;
    if (!replace) {
      this.stack.push(this.state);
      if (this.stack.length > 50) this.stack.shift();
    }
    this.state = merged;
    this.emit('change', this.state);
  }

  /** Update view params (selection etc.) without adding a back-stack entry. */
  patch(params) {
    this.state = { ...this.state, params: { ...this.state.params, ...params } };
  }

  back() {
    const prev = this.stack.pop();
    if (!prev) return false;
    this.state = prev;
    this.emit('change', this.state);
    return true;
  }

  get canGoBack() {
    return this.stack.length > 0;
  }
}

export const router = new Router();
