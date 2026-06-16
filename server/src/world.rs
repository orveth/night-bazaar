//! World geometry + the server-authoritative movement rules.
//!
//! The plane is split by `z`: `z <= street.max_z` is street space, `z >
//! street.max_z` is court space (courts share their `min_z` edge with the
//! street's north wall). That makes region transitions happen ONLY on z-axis
//! steps, so axis-separated integration (x then z) gives wall sliding for free
//! and cannot cut corners through a wall.

use crate::protocol::{BoothSpec, ChestSpec, CourtSpec, Door, Rect, StallSpec, Vec2, World};

/// Jump impulse, units/second (Phase 1a). Apex ≈ JUMP_VY²/(2·GRAVITY) ≈ 1.1.
pub const JUMP_VY: f64 = 5.2;
/// Downward acceleration, units/second².
pub const GRAVITY: f64 = 12.0;

/// Where a point is. Courts are indexed into `World::courts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    Street,
    Court(usize),
    Void,
}

/// What the mover is allowed to do (precomputed from the session).
#[derive(Debug, Clone)]
pub struct MoveCaps {
    /// Bodies can enter entitled courts; ghosts never can.
    pub body: bool,
    /// Entitlement per court index (parallel to `World::courts`).
    pub courts: Vec<bool>,
}

impl MoveCaps {
    pub fn ghost(world: &World) -> Self {
        Self {
            body: false,
            courts: vec![false; world.courts.len()],
        }
    }
}

/// The default world: one street, two courts, market stalls (occluders), and
/// four chests — the original jade-court find plus the Phase-1a hidden three
/// (rooftop / behind-a-stall / dark-alley-corner).
pub fn default_world(price_spawn: u64, price_jade: u64, price_crimson: u64) -> World {
    let _ = price_spawn; // spawn is a gate, not a room — priced in config only

    let stall = |id: &str, kind: &str, x: f64, z: f64, rot: f64, fp: [f64; 4]| StallSpec {
        id: id.into(),
        kind: kind.into(),
        x,
        z,
        rot,
        footprint: Rect {
            min_x: fp[0],
            max_x: fp[1],
            min_z: fp[2],
            max_z: fp[3],
        },
    };
    const PI: f64 = std::f64::consts::PI;

    World {
        street: Rect {
            min_x: -30.0,
            max_x: 30.0,
            min_z: -10.0,
            max_z: 10.0,
        },
        courts: vec![
            CourtSpec {
                id: "jade".into(),
                gate: "court.jade".into(),
                price: price_jade,
                bounds: Rect {
                    min_x: -22.0,
                    max_x: -6.0,
                    min_z: 10.0,
                    max_z: 24.0,
                },
                door: Door { x1: -16.0, x2: -12.0 },
            },
            CourtSpec {
                id: "crimson".into(),
                gate: "court.crimson".into(),
                price: price_crimson,
                bounds: Rect {
                    min_x: 6.0,
                    max_x: 22.0,
                    min_z: 10.0,
                    max_z: 24.0,
                },
                door: Door { x1: 12.0, x2: 16.0 },
            },
        ],
        chests: vec![
            // Phase 0 court find — id and court preserved.
            ChestSpec {
                id: "chest.jade".into(),
                court: "jade".into(),
                x: -14.0,
                y: 0.0,
                z: 20.0,
            },
            // On the potion stall's roof slab: 3.4 up means the 3.0 interact
            // sphere only reaches it mid-jump (apex ≈ 1.1). The x/z sit just
            // inside the footprint so the chest rests ON the roof; claims
            // happen from the walkable lane in front (z ≥ -7.6).
            ChestSpec {
                id: "chest.rooftop".into(),
                court: "street".into(),
                x: 9.0,
                y: 3.4,
                z: -7.8,
            },
            // In the hidden gap BEHIND the trinket stall (its footprint stops
            // 1.0 short of the street's south edge; walk around the side).
            ChestSpec {
                id: "chest.stall".into(),
                court: "street".into(),
                x: -5.0,
                y: 0.0,
                z: -9.5,
            },
            // Dark north-east corner nook, behind the crate stack.
            ChestSpec {
                id: "chest.alley".into(),
                court: "street".into(),
                x: 29.2,
                y: 0.0,
                z: 9.4,
            },
        ],
        // Phase 1b playable booths. Prices here are the contract DEFAULTS;
        // main.rs overrides gacha/bell from config (the riddle stays free).
        // Positions sit inside their region, clear of occluders, in interact
        // range of the walkable lane (asserted in tests).
        booths: vec![
            // Riddle lantern: inside the jade court, free to attempt.
            BoothSpec {
                id: "booth.riddle".into(),
                kind: "riddle".into(),
                court: "jade".into(),
                x: -9.0,
                z: 14.0,
                price: 0,
            },
            // Gacha shrine: inside the crimson court, paid per pull.
            BoothSpec {
                id: "booth.gacha".into(),
                kind: "gacha".into(),
                court: "crimson".into(),
                x: 18.0,
                z: 14.0,
                price: 5,
            },
            // Timing bell: out on the free street near the noodle stall.
            BoothSpec {
                id: "booth.bell".into(),
                kind: "bell".into(),
                court: "street".into(),
                x: 4.5,
                z: 8.5,
                price: 3,
            },
        ],
        stalls: vec![
            // South row (faces north, rot 0), backed against the street edge.
            stall("stall.lantern", "lantern", -26.0, -8.8, 0.0, [-28.0, -24.0, -10.0, -7.6]),
            stall("stall.fish", "fish", -19.0, -8.8, 0.0, [-21.0, -17.0, -10.0, -7.6]),
            stall("stall.tea", "tea", -12.0, -8.8, 0.0, [-14.0, -10.0, -10.0, -7.6]),
            // The trinket stall floats 1.0 off the edge — chest.stall hides behind.
            stall("stall.trinket", "trinket", -5.0, -8.0, 0.0, [-7.0, -3.0, -9.0, -7.0]),
            stall("stall.skewer", "skewer", 2.0, -8.8, 0.0, [0.0, 4.0, -10.0, -7.6]),
            // chest.rooftop sits on this awning.
            stall("stall.potion", "potion", 9.0, -8.8, 0.0, [7.0, 11.0, -10.0, -7.6]),
            stall("stall.fruit", "fruit", 16.0, -8.8, 0.0, [14.0, 18.0, -10.0, -7.6]),
            stall("stall.dumpling", "dumpling", 23.0, -8.8, 0.0, [21.0, 25.0, -10.0, -7.6]),
            // North row (faces south, rot PI), between/around the court walls.
            stall("stall.mask", "mask", -26.0, 8.9, PI, [-28.5, -23.5, 7.8, 10.0]),
            stall("stall.noodle", "noodle", 0.0, 8.9, PI, [-2.5, 2.5, 7.8, 10.0]),
            stall("stall.incense", "incense", 26.0, 8.9, PI, [23.5, 28.5, 7.8, 10.0]),
            // Crate stack screening the dark alley corner (chest.alley nook).
            stall("stall.crates", "crates", 27.6, 6.6, 0.4, [26.8, 28.4, 4.5, 8.8]),
        ],
        spawn_ghost: Vec2 { x: 0.0, z: -6.0 },
        spawn_body: Vec2 { x: 0.0, z: 0.0 },
        speed: 6.0,
        tick_hz: 15,
    }
}

/// True if a point stands inside any stall footprint (movement-blocking).
pub fn in_occluder(world: &World, x: f64, z: f64) -> Option<usize> {
    world
        .stalls
        .iter()
        .position(|s| s.footprint.contains(x, z))
}

/// Does the segment `a -> b` (on the ground plane) cross any stall footprint
/// that contains NEITHER endpoint? Used as a line-of-sight test for
/// interaction: the interact sphere otherwise reaches THROUGH a stall wall
/// (the chest.stall-through-the-trinket-stall quirk). Footprints that contain
/// an endpoint are skipped so a chest resting ON its slab, or a player standing
/// at a booth flush against a stall, never self-blocks.
pub fn segment_blocked_by_stall(world: &World, a: (f64, f64), b: (f64, f64)) -> bool {
    world.stalls.iter().any(|s| {
        let fp = &s.footprint;
        if fp.contains(a.0, a.1) || fp.contains(b.0, b.1) {
            return false;
        }
        segment_intersects_rect(a, b, fp)
    })
}

/// Segment vs axis-aligned rectangle intersection (Liang–Barsky clip). True if
/// any part of the segment lies inside or on the rectangle.
fn segment_intersects_rect(a: (f64, f64), b: (f64, f64), r: &Rect) -> bool {
    let dx = b.0 - a.0;
    let dz = b.1 - a.1;
    // Degenerate segment: it is a point — inside-rect already handled by the
    // endpoint skip, so a zero-length segment never "crosses" a wall.
    let mut t0 = 0.0f64;
    let mut t1 = 1.0f64;
    let clip = |p: f64, q: f64, t0: &mut f64, t1: &mut f64| -> bool {
        if p == 0.0 {
            // Parallel to this boundary: outside if q < 0.
            return q >= 0.0;
        }
        let t = q / p;
        if p < 0.0 {
            if t > *t1 {
                return false;
            }
            if t > *t0 {
                *t0 = t;
            }
        } else {
            if t < *t0 {
                return false;
            }
            if t < *t1 {
                *t1 = t;
            }
        }
        true
    };
    clip(-dx, a.0 - r.min_x, &mut t0, &mut t1)
        && clip(dx, r.max_x - a.0, &mut t0, &mut t1)
        && clip(-dz, a.1 - r.min_z, &mut t0, &mut t1)
        && clip(dz, r.max_z - a.1, &mut t0, &mut t1)
        && t0 <= t1
}

/// One vertical integration step: gravity on `vy`, ground at y = 0.
/// Returns (y, vy). Grounded means y == 0 && vy == 0.
pub fn step_y(y: f64, vy: f64, dt: f64) -> (f64, f64) {
    let vy2 = vy - GRAVITY * dt;
    let y2 = y + vy2 * dt;
    if y2 <= 0.0 {
        (0.0, 0.0)
    } else {
        (y2, vy2)
    }
}

/// Classify a point. Street space is `z <= street.max_z`; court space is
/// strictly above it (the shared edge belongs to the street, so standing ON
/// the wall line is standing in the street).
pub fn region_of(world: &World, x: f64, z: f64) -> Region {
    if z <= world.street.max_z {
        if world.street.contains(x, z) {
            Region::Street
        } else {
            Region::Void
        }
    } else {
        for (i, court) in world.courts.iter().enumerate() {
            if court.bounds.contains(x, z) {
                return Region::Court(i);
            }
        }
        Region::Void
    }
}

/// Whether a single-axis micro-step `from -> to` is legal under `caps`.
fn step_legal(world: &World, caps: &MoveCaps, from: (f64, f64), to: (f64, f64)) -> bool {
    // Stall footprints block everyone (ghosts included). Stepping OUT of a
    // footprint stays legal so nobody can ever be wedged inside one.
    if let Some(idx) = in_occluder(world, to.0, to.1) {
        if in_occluder(world, from.0, from.1) != Some(idx) {
            return false;
        }
    }
    let from_region = region_of(world, from.0, from.1);
    let to_region = region_of(world, to.0, to.1);
    match (from_region, to_region) {
        (_, Region::Void) => false,
        (a, b) if a == b => true,
        // Street -> court: bodies only, entitled only, through the door gap
        // only (both endpoints' x inside the gap — the step is a z-step, so
        // x is unchanged, but check both for robustness).
        (Region::Street, Region::Court(i)) => {
            let door = &world.courts[i].door;
            caps.body
                && caps.courts.get(i).copied().unwrap_or(false)
                && door.covers(from.0)
                && door.covers(to.0)
        }
        // Court -> street: anyone inside may leave, but only through the door
        // (walls are walls in both directions).
        (Region::Court(i), Region::Street) => {
            let door = &world.courts[i].door;
            door.covers(from.0) && door.covers(to.0)
        }
        // Court -> different court would need to tunnel a wall.
        _ => false,
    }
}

/// Integrate one tick of movement: normalize the intent, advance x then z,
/// blocking each axis independently (wall sliding). Returns the new position.
pub fn step(
    world: &World,
    caps: &MoveCaps,
    pos: (f64, f64),
    intent: (f64, f64),
    dt: f64,
) -> (f64, f64) {
    let len = (intent.0 * intent.0 + intent.1 * intent.1).sqrt();
    if len <= f64::EPSILON {
        return pos;
    }
    // Clamp intent to unit length (clients cannot speed-hack by sending big
    // vectors); shorter intents move proportionally slower.
    let scale = if len > 1.0 { 1.0 / len } else { 1.0 };
    let dx = intent.0 * scale * world.speed * dt;
    let dz = intent.1 * scale * world.speed * dt;

    let mut current = pos;
    let x_target = (current.0 + dx, current.1);
    if step_legal(world, caps, current, x_target) {
        current = x_target;
    }
    let z_target = (current.0, current.1 + dz);
    if step_legal(world, caps, current, z_target) {
        current = z_target;
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> World {
        default_world(10, 50, 200)
    }

    fn caps_body_entitled(world: &World, court_id: &str) -> MoveCaps {
        MoveCaps {
            body: true,
            courts: world.courts.iter().map(|c| c.id == court_id).collect(),
        }
    }

    fn walk_north(world: &World, caps: &MoveCaps, start: (f64, f64), ticks: u32) -> (f64, f64) {
        let dt = 1.0 / world.tick_hz as f64;
        let mut pos = start;
        for _ in 0..ticks {
            pos = step(world, caps, pos, (0.0, 1.0), dt);
        }
        pos
    }

    #[test]
    fn regions_classify() {
        let w = world();
        assert_eq!(region_of(&w, 0.0, 0.0), Region::Street);
        assert_eq!(region_of(&w, -14.0, 20.0), Region::Court(0));
        assert_eq!(region_of(&w, 14.0, 20.0), Region::Court(1));
        assert_eq!(region_of(&w, 0.0, 20.0), Region::Void); // between courts
        assert_eq!(region_of(&w, -31.0, 0.0), Region::Void);
        // The shared wall line belongs to the street.
        assert_eq!(region_of(&w, -14.0, 10.0), Region::Street);
    }

    #[test]
    fn ghost_blocked_at_door() {
        let w = world();
        let caps = MoveCaps::ghost(&w);
        // Start in the jade door lane, walk north hard.
        let end = walk_north(&w, &caps, (-14.0, 8.0), 60);
        assert_eq!(region_of(&w, end.0, end.1), Region::Street);
        assert!(end.1 <= w.street.max_z, "ghost crossed the wall: {end:?}");
    }

    #[test]
    fn body_without_entitlement_blocked() {
        let w = world();
        let caps = MoveCaps {
            body: true,
            courts: vec![false, false],
        };
        let end = walk_north(&w, &caps, (-14.0, 8.0), 60);
        assert_eq!(region_of(&w, end.0, end.1), Region::Street);
    }

    #[test]
    fn entitled_body_enters_through_door() {
        let w = world();
        let caps = caps_body_entitled(&w, "jade");
        let end = walk_north(&w, &caps, (-14.0, 8.0), 60);
        assert_eq!(region_of(&w, end.0, end.1), Region::Court(0));
    }

    #[test]
    fn entitled_body_blocked_outside_door_gap() {
        let w = world();
        let caps = caps_body_entitled(&w, "jade");
        // x = -20 is inside jade's bounds but OUTSIDE its door gap.
        let end = walk_north(&w, &caps, (-20.0, 8.0), 60);
        assert_eq!(region_of(&w, end.0, end.1), Region::Street);
    }

    #[test]
    fn entitlement_is_per_court() {
        let w = world();
        let caps = caps_body_entitled(&w, "jade");
        // jade entitlement does not open crimson's door.
        let end = walk_north(&w, &caps, (14.0, 8.0), 60);
        assert_eq!(region_of(&w, end.0, end.1), Region::Street);
    }

    #[test]
    fn exit_requires_the_door_too() {
        let w = world();
        let caps = caps_body_entitled(&w, "jade");
        let dt = 1.0 / w.tick_hz as f64;
        // Inside jade, away from the door in x: walking south sticks at the wall.
        let mut pos = (-20.0, 12.0);
        for _ in 0..60 {
            pos = step(&w, &caps, pos, (0.0, -1.0), dt);
        }
        assert_eq!(region_of(&w, pos.0, pos.1), Region::Court(0));
        // Through the door lane it gets out.
        let mut pos = (-14.0, 12.0);
        for _ in 0..60 {
            pos = step(&w, &caps, pos, (0.0, -1.0), dt);
        }
        assert_eq!(region_of(&w, pos.0, pos.1), Region::Street);
    }

    #[test]
    fn wall_slide_keeps_lateral_motion() {
        let w = world();
        let caps = MoveCaps::ghost(&w);
        let dt = 1.0 / w.tick_hz as f64;
        // Diagonal into the north wall: z blocked, x still advances.
        // (x = 3.5 keeps the lane clear of the noodle stall footprint.)
        let start = (3.5, 9.9);
        assert_eq!(in_occluder(&w, start.0, start.1), None, "test lane must be clear");
        let end = step(&w, &caps, start, (1.0, 1.0), dt);
        assert!(end.0 > start.0, "x should slide along the wall");
        assert!(end.1 <= w.street.max_z);
    }

    #[test]
    fn stall_footprints_block_movement_and_slide() {
        let w = world();
        let caps = MoveCaps::ghost(&w);
        let dt = 1.0 / w.tick_hz as f64;
        // Walk south into the potion stall (footprint x 7..11, z -10..-7.6):
        // z must stop at the footprint edge.
        let mut pos = (9.0, -6.0);
        for _ in 0..40 {
            pos = step(&w, &caps, pos, (0.0, -1.0), dt);
        }
        assert!(pos.1 >= -7.6, "walked into the stall: {pos:?}");
        assert_eq!(in_occluder(&w, pos.0, pos.1), None);
        // A diagonal step against the stall face still slides in x.
        let slid = step(&w, &caps, pos, (1.0, -1.0), dt);
        assert!(slid.0 > pos.0, "x should slide along the stall front");
        assert!(slid.1 >= -7.6);
    }

    #[test]
    fn hidden_chests_are_reachable_on_foot() {
        let w = world();
        let caps = MoveCaps::ghost(&w); // street chests need no entitlement to REACH
        let dt = 1.0 / w.tick_hz as f64;

        // chest.stall: walk the lane x -10..-7 down to the south edge, then
        // east along the hidden gap behind the trinket stall.
        let mut pos = (-8.5, -6.0);
        for _ in 0..70 {
            pos = step(&w, &caps, pos, (0.0, -1.0), dt);
        }
        assert!(pos.1 < -9.2, "should reach the south gap: {pos:?}");
        for _ in 0..10 {
            pos = step(&w, &caps, pos, (1.0, 0.0), dt);
        }
        let chest = w.chests.iter().find(|c| c.id == "chest.stall").unwrap();
        let d = ((pos.0 - chest.x).powi(2) + (pos.1 - chest.z).powi(2)).sqrt();
        assert!(d < 3.0, "behind-the-stall chest unreachable: {pos:?} vs ({}, {})", chest.x, chest.z);

        // chest.alley: walk east along z=2, then north up the corridor east
        // of the crates (x ≈ 29.2).
        let mut pos = (24.0, 2.0);
        for _ in 0..120 {
            pos = step(&w, &caps, pos, (1.0, 0.0), dt);
        }
        assert!(pos.0 > 28.6, "east corridor blocked: {pos:?}");
        for _ in 0..80 {
            pos = step(&w, &caps, pos, (0.0, 1.0), dt);
        }
        let chest = w.chests.iter().find(|c| c.id == "chest.alley").unwrap();
        let d = ((pos.0 - chest.x).powi(2) + (pos.1 - chest.z).powi(2)).sqrt();
        assert!(d < 3.0, "alley chest unreachable: {pos:?} vs ({}, {})", chest.x, chest.z);

        // chest.rooftop: the spot under the awning lip is walkable street.
        let chest = w.chests.iter().find(|c| c.id == "chest.rooftop").unwrap();
        let under = (chest.x, -7.5);
        assert_eq!(region_of(&w, under.0, under.1), Region::Street);
        assert_eq!(in_occluder(&w, under.0, under.1), None);
        // Standing there, the chest is OUT of the 3.0 interact sphere from
        // the ground but INSIDE it at the jump apex.
        let horiz = ((under.0 - chest.x).powi(2) + (under.1 - chest.z).powi(2)).sqrt();
        let from_ground = (horiz.powi(2) + chest.y.powi(2)).sqrt();
        assert!(from_ground > 3.0, "rooftop chest must not be claimable from the ground");
        let apex = JUMP_VY * JUMP_VY / (2.0 * GRAVITY);
        let from_apex = (horiz.powi(2) + (chest.y - apex).powi(2)).sqrt();
        assert!(from_apex < 3.0, "rooftop chest must be claimable at the jump apex");
    }

    #[test]
    fn spawns_doors_and_court_chest_stay_clear_of_occluders() {
        let w = world();
        assert_eq!(in_occluder(&w, w.spawn_ghost.x, w.spawn_ghost.z), None);
        assert_eq!(in_occluder(&w, w.spawn_body.x, w.spawn_body.z), None);
        for court in &w.courts {
            // The approach lane in front of each door must be walkable.
            let cx = (court.door.x1 + court.door.x2) / 2.0;
            for z in [6.0, 8.0, 9.9] {
                assert_eq!(
                    in_occluder(&w, cx, z),
                    None,
                    "door lane of {} blocked at z={z}",
                    court.id
                );
            }
        }
        for chest in &w.chests {
            if chest.id == "chest.rooftop" {
                continue; // sits ON a stall roof by design
            }
            assert_eq!(in_occluder(&w, chest.x, chest.z), None, "{} buried in a stall", chest.id);
        }
    }

    #[test]
    fn jump_arc_rises_and_lands() {
        let dt = 1.0 / 15.0;
        let (mut y, mut vy) = (0.0, JUMP_VY);
        let mut apex: f64 = 0.0;
        let mut steps = 0;
        loop {
            let (y2, vy2) = step_y(y, vy, dt);
            y = y2;
            vy = vy2;
            apex = apex.max(y);
            steps += 1;
            if y == 0.0 && vy == 0.0 {
                break;
            }
            assert!(steps < 60, "jump never landed");
        }
        assert!(apex > 0.8 && apex < 1.3, "apex {apex} out of the designed window");
        assert!(steps >= 8, "air time too short to claim the rooftop chest: {steps} ticks");
    }

    #[test]
    fn speed_is_clamped() {
        let w = world();
        let caps = MoveCaps::ghost(&w);
        let dt = 1.0 / w.tick_hz as f64;
        let from = (0.0, 0.0);
        let end = step(&w, &caps, from, (100.0, 0.0), dt);
        let moved = end.0 - from.0;
        let max = w.speed * dt + 1e-9;
        assert!(moved <= max, "moved {moved} > per-tick max {max}");
    }

    #[test]
    fn los_blocks_through_a_stall_but_not_along_an_open_lane() {
        let w = world();
        let chest = w.chests.iter().find(|c| c.id == "chest.stall").unwrap();
        let target = (chest.x, chest.z); // (-5, -9.5), behind the trinket stall
        // From the street side (front of the trinket stall) the footprint sits
        // on the line of sight -> blocked (THE QUIRK FIX).
        assert!(
            segment_blocked_by_stall(&w, (-5.0, -6.6), target),
            "claiming through the trinket stall must be blocked"
        );
        // From the hidden gap directly behind it, the line is clear.
        assert!(
            !segment_blocked_by_stall(&w, (-5.0, -9.4), target),
            "the behind-the-stall approach must be clear"
        );
        // A wide-open court interaction (no stalls between) is never blocked.
        assert!(!segment_blocked_by_stall(&w, (-14.0, 12.0), (-14.0, 20.0)));
        // An endpoint INSIDE a footprint (rooftop chest on its slab) does not
        // self-block: the potion footprint contains the chest point.
        let roof = w.chests.iter().find(|c| c.id == "chest.rooftop").unwrap();
        assert!(in_occluder(&w, roof.x, roof.z).is_some(), "rooftop chest sits in a footprint");
        assert!(
            !segment_blocked_by_stall(&w, (roof.x, -7.4), (roof.x, roof.z)),
            "a target on its own slab must not self-block"
        );
    }

    #[test]
    fn booths_sit_in_their_regions_clear_of_occluders() {
        let w = world();
        assert_eq!(w.booths.len(), 3);
        for booth in &w.booths {
            assert_eq!(
                in_occluder(&w, booth.x, booth.z),
                None,
                "{} is buried in a stall",
                booth.id
            );
            let region = region_of(&w, booth.x, booth.z);
            match booth.court.as_str() {
                "street" => assert_eq!(region, Region::Street, "{} not on the street", booth.id),
                court => {
                    let idx = w.courts.iter().position(|c| c.id == court).unwrap();
                    assert_eq!(region, Region::Court(idx), "{} not in {court}", booth.id);
                }
            }
        }
    }

    #[test]
    fn void_clamps_at_street_edge() {
        let w = world();
        let caps = MoveCaps::ghost(&w);
        let dt = 1.0 / w.tick_hz as f64;
        let mut pos = (29.5, 0.0);
        for _ in 0..30 {
            pos = step(&w, &caps, pos, (1.0, 0.0), dt);
        }
        assert!(pos.0 <= w.street.max_x);
        assert_eq!(region_of(&w, pos.0, pos.1), Region::Street);
    }
}
