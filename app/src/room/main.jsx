// The screening room (app/room/index.html). Preact, its own code, the written
// FAQ and its matcher, and hls.js on demand: nothing from the wallet, the
// chain code or libauth (scripts/check-app-dist.js and test-room/ check it).
import { render } from 'preact';
import './room.css';
import { createRoomController } from './controller.js';
import { Room } from './Room.jsx';

const controller = createRoomController();
render(<Room controller={controller} />, document.getElementById('room'));
controller.start();
