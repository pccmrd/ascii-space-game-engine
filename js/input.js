// input.js — keyboard + mouse state with edge detection.

const GAME_KEYS = new Set([
  'KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','KeyR','KeyF','KeyT','KeyG','KeyH','KeyJ','KeyK','KeyL',
  'KeyM','KeyN','KeyV','KeyX','KeyZ','KeyC','Space','Tab','ShiftLeft','ShiftRight','ControlLeft',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape','Enter','Digit1','Digit2','Digit3','Digit4',
  'Digit5','Digit6','Digit7','Digit8','Minus','Equal','Comma','Period','Backquote','KeyP','KeyB','KeyU',
]);

export class Input {
  constructor(target = window) {
    this.keys = new Set();        // currently held (e.code)
    this.pressed = new Set();     // pressed since last endFrame()
    this.released = new Set();
    this.mouse = { x: 0, y: 0, down: false, clicked: false, rclicked: false };
    this.anyKey = false;          // set true on any keydown (title screen)
    this._onKeyDown = (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) {
        this.pressed.add(e.code);
        this.anyKey = true;
      }
      this.keys.add(e.code);
      if (this.onFirstKey) { this.onFirstKey(); this.onFirstKey = null; }
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); this.released.add(e.code); };
    this._onMouseMove = (e) => {
      const r = this._rect ? this._rect() : { left: 0, top: 0 };
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    };
    this._onMouseDown = (e) => {
      if (e.button === 0) { this.mouse.down = true; this.mouse.clicked = true; }
      if (e.button === 2) { this.mouse.rclicked = true; }
      if (this.onFirstKey) { this.onFirstKey(); this.onFirstKey = null; }
    };
    this._onMouseUp = (e) => { if (e.button === 0) this.mouse.down = false; };
    this._onCtx = (e) => e.preventDefault();
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    if (target === window) {
      window.addEventListener('mousemove', this._onMouseMove);
      window.addEventListener('mousedown', this._onMouseDown);
      window.addEventListener('mouseup', this._onMouseUp);
      window.addEventListener('contextmenu', this._onCtx);
    } else {
      target.addEventListener('mousemove', this._onMouseMove);
      target.addEventListener('mousedown', this._onMouseDown);
      target.addEventListener('mouseup', this._onMouseUp);
      target.addEventListener('contextmenu', this._onCtx);
    }
    this._rectFn = null;
  }
  bindCanvasRect(fn) { this._rect = fn; }
  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }   // edge
  up(code) { return this.released.has(code); }
  axis(negCode, posCode) {
    return (this.down(posCode) ? 1 : 0) - (this.down(negCode) ? 1 : 0);
  }
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.clicked = false;
    this.mouse.rclicked = false;
    this.anyKey = false;
  }
}
