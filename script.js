// ---- Grab references to the HTML elements we'll work with ----
const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');       // redraws every frame (skeleton)
const ctx = canvas.getContext('2d');
const drawCanvas = document.getElementById('draw-canvas'); // PERSISTENT — strokes stay until cleared
const drawCtx = drawCanvas.getContext('2d');

const startBtn = document.getElementById('start-btn');
const trackBtn = document.getElementById('track-btn');
const clearBtn = document.getElementById('clear-btn');
const statusEl = document.getElementById('status');

const modeDrawBtn = document.getElementById('mode-draw-btn');
const modeMediaBtn = document.getElementById('mode-media-btn');
const mediaSection = document.getElementById('media-section');
const demoVideo = document.getElementById('demo-video');
const mediaStatusEl = document.getElementById('media-status');

let detector = null;
let isTracking = false;
let mode = 'draw'; // 'draw' or 'media' — controls what the gesture data is USED for

// Where the pen currently is on the drawing canvas. null = pen is "up" (not drawing).
let prevDrawX = null;
let prevDrawY = null;

// Used to detect the MOMENT a fist closes, not every frame it's closed
// (otherwise play/pause would fire 30 times a second while your fist stays closed).
let wasFist = false;

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
];

// Plain distance formula between two points — used for both pinch and fist detection
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---- Gesture 1: is the thumb tip pinched against the index fingertip? ----
function isPinching(keypoints) {
  const thumbTip = keypoints[4];
  const indexTip = keypoints[8];

  // We compare against the hand's own size (wrist-to-knuckle distance) instead of
  // a fixed pixel number, so pinch detection still works whether your hand is
  // close to the camera (looks big) or far away (looks small).
  const handSize = distance(keypoints[0], keypoints[9]);
  const pinchDist = distance(thumbTip, indexTip);

  return pinchDist < handSize * 0.35;
}

// ---- Gesture 2: is the hand a closed fist? ----
function isFist(keypoints) {
  const wrist = keypoints[0];
  // Fingertip indexes vs. their corresponding middle-knuckle indexes
  const tips = [8, 12, 16, 20];
  const knuckles = [6, 10, 14, 18];

  const avgTipDist = tips.reduce((sum, i) => sum + distance(keypoints[i], wrist), 0) / tips.length;
  const avgKnuckleDist = knuckles.reduce((sum, i) => sum + distance(keypoints[i], wrist), 0) / knuckles.length;

  // In a fist, fingertips curl IN, ending up closer to the wrist than the knuckles are.
  // In an open hand, fingertips are further from the wrist than the knuckles.
  return avgTipDist < avgKnuckleDist;
}

// ---- Step 1: get the webcam working ----
async function startCamera() {
  statusEl.textContent = 'Requesting camera access...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }
    });

    video.srcObject = stream;

    statusEl.textContent = 'Camera running ✅ Loading AI model...';
    startBtn.disabled = true;

    await loadModel();
  } catch (err) {
    statusEl.textContent = 'Camera access failed: ' + err.message;
    console.error(err);
  }
}

// ---- Step 2: load the pre-trained hand model ----
async function loadModel() {
  await tf.setBackend('webgl');
  await tf.ready();

  const model = handPoseDetection.SupportedModels.MediaPipeHands;
  const detectorConfig = {
    runtime: 'mediapipe',
    solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands',
    modelType: 'full'
  };

  detector = await handPoseDetection.createDetector(model, detectorConfig);

  statusEl.textContent = 'Model loaded ✅ Click "Start Tracking"';
  trackBtn.disabled = false;
}

// ---- Draw Mode: turn pinch + fingertip movement into an ink stroke ----
function handleDrawMode(hand) {
  const indexTip = hand.keypoints[8];

  if (isPinching(hand.keypoints)) {
    if (prevDrawX !== null) {
      // Draw a line from where the finger WAS last frame to where it is NOW.
      // Doing this every frame, many times a second, is what makes it look
      // like a continuous stroke instead of separate dots.
      drawCtx.strokeStyle = '#ff5c5c';
      drawCtx.lineWidth = 4;
      drawCtx.lineCap = 'round';
      drawCtx.beginPath();
      drawCtx.moveTo(prevDrawX, prevDrawY);
      drawCtx.lineTo(indexTip.x, indexTip.y);
      drawCtx.stroke();
    }
    prevDrawX = indexTip.x;
    prevDrawY = indexTip.y;
  } else {
    // Pen lifted — reset so the NEXT pinch starts a fresh line instead of
    // jumping/connecting to wherever the finger was last time.
    prevDrawX = null;
    prevDrawY = null;
  }
}

// ---- Media Mode: fist toggles play/pause, hand height controls volume ----
function handleMediaMode(hand) {
  const fist = isFist(hand.keypoints);

  // Only trigger on the TRANSITION from open -> fist (a "just closed" edge),
  // not on every frame the fist stays closed.
  if (fist && !wasFist) {
    if (demoVideo.paused) {
      demoVideo.play();
    } else {
      demoVideo.pause();
    }
  }
  wasFist = fist;

  // Map the wrist's vertical position to volume: higher hand = louder.
  // keypoints are in pixel space (0 to canvas.height), so we flip and normalize to 0–1.
  const wristY = hand.keypoints[0].y;
  const volume = 1 - Math.min(Math.max(wristY / canvas.height, 0), 1);
  demoVideo.volume = volume;

  mediaStatusEl.textContent = `Volume: ${Math.round(volume * 100)}% | ${demoVideo.paused ? 'Paused' : 'Playing'}`;
}

// ---- Step 3: the continuous detect -> draw -> repeat loop ----
async function trackingLoop() {
  if (!isTracking) return;

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    drawCanvas.width = video.videoWidth;
    drawCanvas.height = video.videoHeight;
  }

  const hands = await detector.estimateHands(video);

  // The skeleton overlay is redrawn from scratch every frame (temporary)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  hands.forEach(hand => {
    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 3;
    HAND_CONNECTIONS.forEach(([startIdx, endIdx]) => {
      const start = hand.keypoints[startIdx];
      const end = hand.keypoints[endIdx];
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    });

    hand.keypoints.forEach(point => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#4f9dff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // The drawing canvas is NOT cleared each frame — only mode-specific
    // functions add to it, so strokes persist until "Clear Drawing" is clicked.
    if (mode === 'draw') {
      handleDrawMode(hand);
    } else if (mode === 'media') {
      handleMediaMode(hand);
    }
  });

  statusEl.textContent = hands.length > 0
    ? `Tracking ${hands.length} hand(s) live 🔵`
    : 'Tracking... (no hand in frame)';

  requestAnimationFrame(trackingLoop);
}

function toggleTracking() {
  isTracking = !isTracking;

  if (isTracking) {
    trackBtn.textContent = 'Stop Tracking';
    trackingLoop();
  } else {
    trackBtn.textContent = 'Start Tracking';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    statusEl.textContent = 'Tracking stopped';
  }
}

function setMode(newMode) {
  mode = newMode;

  modeDrawBtn.classList.toggle('active', mode === 'draw');
  modeMediaBtn.classList.toggle('active', mode === 'media');
  mediaSection.classList.toggle('hidden', mode !== 'media');

  // Reset draw-in-progress state so switching modes mid-pinch doesn't
  // leave a stray line hanging.
  prevDrawX = null;
  prevDrawY = null;
}

startBtn.addEventListener('click', startCamera);
trackBtn.addEventListener('click', toggleTracking);
clearBtn.addEventListener('click', () => drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height));
modeDrawBtn.addEventListener('click', () => setMode('draw'));
modeMediaBtn.addEventListener('click', () => setMode('media'));
