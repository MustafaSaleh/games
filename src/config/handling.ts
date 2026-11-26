/**
 * Arcade car handling. All physics tuning lives here.
 * Units: metres, seconds, radians. Physics runs at a fixed 60 Hz.
 */
export const HANDLING = {
  // --- geometry ---
  wheelBase: 2.5,
  /** two collision circles along the car (front/rear offset from centre) */
  colliderOffset: 1.05,
  colliderRadius: 1.0,

  // --- engine / brakes ---
  engineAccel: 11.5, // m/s^2 at standstill on tarmac
  topSpeed: 46, // m/s (~166 km/h) – engine force fades to 0 here
  engineBraking: 0.9, // m/s^2 when coasting
  brakeDecel: 24,
  reverseAccel: 8,
  reverseTopSpeed: 13,

  // --- steering ---
  maxSteer: 0.62, // rad, front wheel angle at standstill
  steerSpeedFalloff: 0.1, // steer angle /= (1 + speed * falloff)
  yawResponse: 9, // how fast yaw rate follows the steering target (1/s)
  minYawSpeed: 1.5, // below this speed steering fades out
  maxLatAccel: 21, // m/s^2 on grip=1: caps yaw rate at speed (full lock = slide, not spin)
  yawCapBase: 0.3, // rad/s always allowed on top of the cap
  slideYawCap: 0.7, // cap multiplier added while sliding (1 + slide * this)

  // --- grip / drift ---
  lateralGrip: 7.5, // 1/s decay of sideways velocity on grip=1
  slideGrip: 0.42, // grip multiplier once the car is sliding (keeps drifts alive)
  slideAngle: 0.22, // slip angle (rad) where sliding starts
  slideBoost: 0.22, // fraction of scrubbed sideways speed turned into forward speed
  driftYawBoost: 0.9, // extra rotation while sliding with steering input
  counterSteerAssist: 0.35, // auto-catch: yaw damping toward velocity direction
  handbrakeGrip: 0.22, // lateral grip multiplier with handbrake
  handbrakeYaw: 1.7, // yaw boost with handbrake
  handbrakeDecel: 5,
  driftMarkSlip: 2.6, // sideways m/s above which tire marks / dust appear

  // --- terrain / air ---
  slopeGravity: 12, // gravity used for the along-slope pull (lower = less uphill penalty)
  airGravity: 20, // gravity while airborne (arcade: > 9.81 so jumps aren't floaty)
  airborneGap: 0.09, // m above ground before we count as airborne
  airYawControl: 1.2, // how much you can rotate in the air
  airDrag: 0.01,
  landingSpeedLoss: 0.012, // fraction of speed lost per m/s of landing impact
  landingHardImpact: 6, // m/s – haptics / camera shake threshold

  // --- visual suspension (does not affect handling) ---
  suspStiffness: 160,
  suspDamping: 13,
  bodyRoll: 0.012, // rad per m/s^2 lateral accel
  bodyPitch: 0.008,

  // --- collisions ---
  restitution: 0.28,
  collisionFriction: 0.25,
  collisionSpin: 0.08,
};

export type Handling = typeof HANDLING;
