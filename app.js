import { loadShadersFromURLS, buildProgramFromSources, setupWebGL } from "./libs/utils.js";
import { flatten, lookAt, ortho, vec3,mult,vec4 } from "./libs/MV.js";
import * as STACK from "./libs/stack.js";

import * as CUBE from "./libs/objects/cube.js";
import * as SPHERE from "./libs/objects/sphere.js";
import * as CYLINDER from "./libs/objects/cylinder.js";
import * as PYRAMID from "./libs/objects/pyramid.js";
import * as TORUS from "./libs/objects/torus.js";

import { node, leaf, count_primitives, draw,find,world,to_local,reparent } from "./scenegraph.js";

import { GUI } from "./libs/dat.gui.module.js";
/** @type {HTMLCanvasElement} */
let canvas;
/** @type {WebGL2RenderingContext} */
let gl;

let program;

const PRIMITIVES = { cube: CUBE, sphere: SPHERE, cylinder: CYLINDER, pyramid: PYRAMID, torus: TORUS };

let scene;
let zoom = 3;           // half the height of the view, in world units


//steering parameters
let steer_angle = 0;
const MAX_STEER = 35;
const STEER_SPEED = 60; // gradi al secondo

//Ground constants---------------//
const WORLD_LENGTH = 40;
const TILE_SIDE = 2;
const TILE_THICKNESS = 0.05;
//------------------------------//
//Rover constants --------------//
const BODY_Y = 0.95;
const BODY_LENGTH = 2.5;
const BODY_WIDTH = 1.5;
const DECK_HEIGHT = 1.1;
const BODY_HEIGHT = 0.3;
const DRIVE_SPEED = 1; // metri al secondo
const AXLE_DISTANCE = 0.9; // distanza tra asse centrale e anteriore
const WHEEL_RADIUS = 0.28; // raggio esterno del toro: (0.5 + 0.2) * 0.4
const ARM_SPEED = 45; // gradi al secondo
const GRIPPER_SPEED = 0.3; // metri al secondo per dito
const MAX_TURRET = 60;
const MIN_SHOULDER = -80;
const MAX_SHOULDER = 10;
const MIN_ELBOW = -145;
const MAX_ELBOW = 100;
const MAST_SPEED = 45; // gradi al secondo
const MAX_MAST_PAN = 120;
const MIN_MAST_TILT = -45;
const MAX_MAST_TILT = 60;
const MIN_GRIPPER = 0.04 / 2; // dita a contatto, senza sovrapporsi
const MAX_GRIPPER = 0.55 / 2 - MIN_GRIPPER; // dita entro la larghezza della base
let gripper_opening = MAX_GRIPPER; // distanza di ogni dito dal centro
let gripper_closed = false;

let grabbedRock = null;
const GRAB_DISTANCE = 0.25;
//-------------------------------
const params = {
    samples: 0
};
// ---------------------------------------------------------------------------
// Scena: terreno a scacchi e rover costruito con primitive semplici.
// ---------------------------------------------------------------------------

function setup_gui() {
    const gui = new GUI();

    const counter = gui.add(params, "samples")
        .name("Samples")
        .listen();

    counter.domElement.querySelector("input").disabled = true;
}

function grabRock() {
    const tool = find(scene, "tool");

    const p = mult(world(tool), vec4(0, 0, 0, 1));

    let nearestRock = null;
    let minDistance = GRAB_DISTANCE;

    for (const rock of scene.children) {

        if (!rock.name.startsWith("rock_"))
            continue;

        const t = rock.transform.translation;

        const dx = p[0] - t[0];
        const dy = p[1] - t[1];
        const dz = p[2] - t[2];

        const distance = Math.sqrt(
            dx * dx + dy * dy + dz * dz
        );

        if (distance < minDistance) {
            minDistance = distance;
            nearestRock = rock;
        }
    }

    if (nearestRock !== null) {
        reparent(nearestRock, tool);
        nearestRock.transform.translation = [0, 0, 0];

        grabbedRock = nearestRock;
    }
}

function createRocks() {
    const rocks = [];

    const positions = [
        [3, 0],
        [4, 2],
        [-3, 2],
        [2, -4],
        [-5, -3],
        [6, 4],
        [-4, 5],
        [7, -2]
    ];

    for (let i = 0; i < positions.length; i++) {

        const sx = 0.3;
        const sy = 0.2 + i * 0.02;
        const sz = 0.25;

        rocks.push(
            leaf(`rock_${i}`, "sphere", [0.5, 0.4, 0.3, 1], {
                t: [positions[i][0], sy / 2, positions[i][1]],
                s: [sx, sy, sz]
            })
        );
    }

    return rocks;
}
function dropRock() {

    if (grabbedRock === null)
        return;

    const tool = find(scene, "tool");
    const bin = find(scene, "bin");

    // Posizione della pinza nel mondo
    const p = mult(world(tool), vec4(0, 0, 0, 1));

    // Posizione della pinza rispetto al contenitore
    const local = to_local(bin, p);

    // Meta' dell'altezza della roccia
    const h = grabbedRock.transform.scale[1] / 2;

    if (Math.abs(local[0]) < 0.30 &&
        Math.abs(local[2]) < 0.30 &&
        local[1] >= 0.35) {

        // Deposito nel contenitore
        reparent(grabbedRock, bin);

        grabbedRock.transform.translation = [
            local[0],
            0.05 + h,
            local[2]
        ];

    } else {

        // Deposito sul terreno
        reparent(grabbedRock, scene);

        grabbedRock.transform.translation = [
            p[0],
            h,
            p[2]
        ];
    }

    grabbedRock = null;
    updateCounter();
}
function updateCounter() {
    const bin = find(scene, "bin");

    let count = 0;

    for (const child of bin.children) {
        if (child.name.startsWith("rock_")) {
            count++;
        }
    }

    params.samples = count;
}
function createGround() {

    const tiles = [];

    for (let i = 0; i < WORLD_LENGTH / TILE_SIDE; i++) {
        for (let j = 0; j < WORLD_LENGTH / TILE_SIDE; j++) {

            const color = (i + j) % 2 === 0
                ? [0.55, 0.30, 0.15, 1]
                : [0.75, 0.50, 0.30, 1];

            tiles.push(
                leaf(`tile_${i}_${j}`, "cube", color, {
                    t: [
                        i * TILE_SIDE - WORLD_LENGTH / 2 + TILE_SIDE / 2,
                        -TILE_THICKNESS / 2,
                        j * TILE_SIDE - WORLD_LENGTH / 2 + TILE_SIDE / 2
                    ],
                    s: [TILE_SIDE, TILE_THICKNESS, TILE_SIDE]
                })
            );
        }
    }

    return node("ground", {}, tiles);
}


// Pannello piatto sul retro del rover (il davanti e' lungo +X).
function createSolarPanel() {
    return leaf("solar_panel", "cube", [0.08, 0.12, 0.30, 1], {
        t: [-0.8, DECK_HEIGHT + 0.025, 0],
        s: [1.3, 0.05, 1.8]
    });
}

// Scatola aperta: un fondo e quattro pareti, senza coperchio.
function createSampleBin() {
    const color = [0.85, 0.55, 0.15, 1];

    return node("bin", { t: [0.5, DECK_HEIGHT, -0.25] }, [
        leaf("bin_floor", "cube", [0.55, 0.33, 0.08, 1], {
            t: [0, 0.025, 0], s: [0.7, 0.05, 0.7]
        }),
        leaf("bin_front", "cube", color, {
            t: [0.325, 0.2, 0], s: [0.05, 0.3, 0.7]
        }),
        leaf("bin_back", "cube", color, {
            t: [-0.325, 0.2, 0], s: [0.05, 0.3, 0.7]
        }),
        leaf("bin_left", "cube", color, {
            t: [0, 0.2, -0.325], s: [0.6, 0.3, 0.05]
        }),
        leaf("bin_right", "cube", color, {
            t: [0, 0.2, 0.325], s: [0.6, 0.3, 0.05]
        })
    ]);
}

// Asta e testa con due obiettivi rivolti in avanti, lungo +X.
function createCameraMast() {
    const metal = [0.75, 0.70, 0.60, 1];
    const lens = [0.35, 0.45, 0.55, 1];

    return node("mast", { t: [0.9, DECK_HEIGHT, 0.45] }, [
        leaf("mast_base", "cylinder", metal, {
            t: [0, 0.04, 0], s: [0.2, 0.08, 0.2]
        }),
        leaf("mast_pole", "cylinder", metal, {
            t: [0, 0.7, 0], s: [0.07, 1.4, 0.07]
        }),
        node("camera_head", { t: [0, 1.45, 0] }, [
            leaf("camera_housing", "cube", [0.12, 0.12, 0.12, 1], {
                s: [0.3, 0.22, 0.55]
            }),
            leaf("camera_left_lens", "cylinder", lens, {
                t: [0.18, 0, -0.15], r: [0, 0, -90], s: [0.12, 0.08, 0.12]
            }),
            leaf("camera_right_lens", "cylinder", lens, {
                t: [0.18, 0, 0.15], r: [0, 0, -90], s: [0.12, 0.08, 0.12]
            })
        ])
    ]);
}
function crateArm() {
    const metal = [0.8, 0.72, 0.60, 1];
    const joint = [0.4, 0.4, 0.4, 1];

    // Attacco sul muso, con due aste sottili e il gomito ripiegato.
    return node("arm", {
        t: [BODY_LENGTH / 2 + 0.06, BODY_Y, 0]
    }, [
        leaf("arm_mount", "cylinder", metal, {
            s: [0.28, 0.12, 0.28]
        }),
        node("shoulder", {
            t: [0.15, 0, 0],
            r: [0, 0, -25]
        }, [
            leaf("shoulder_joint", "cylinder", joint, {
                r: [90, 0, 0],
                s: [0.14, 0.12, 0.14]
            }),
            leaf("upper_arm", "cube", metal, {
                t: [0, 0.475, 0],
                s: [0.055, 0.95, 0.055]
            }),
            node("elbow", {
                t: [0, 0.95, 0],
                r: [0, 0, -145]
            }, [
                leaf("elbow_joint", "cylinder", joint, {
                    r: [90, 0, 0],
                    s: [0.12, 0.12, 0.12]
                }),
                leaf("forearm", "cube", metal, {
                    t: [0, 0.39, 0],
                    s: [0.06, 0.78, 0.06]
                }),
                node("wrist", {
                    t: [0, 0.78, 0],
                    r: [0, 0, 170]
                }, [
                    leaf("gripper_base", "cube",
                        [0.15, 0.15, 0.15, 1], {
                        s: [0.12, 0.08, 0.55]
                    }
                    ),

                    leaf("gripper_left", "cube", metal, {
                        t: [0, -0.14, -MAX_GRIPPER],
                        s: [0.05, 0.28, 0.04]
                    }),

                    leaf("gripper_right", "cube", metal, {
                        t: [0, -0.14, MAX_GRIPPER],
                        s: [0.05, 0.28, 0.04]
                    }),

                    node("tool", {
                        t: [0, -0.14, 0]
                    }, [])
                ])
            ])
        ])
    ]);
}
export function createRover() {

    function wheel(id, x, y, z) {

        //         wheel          → posiziona la ruota sul rover
        //           └── steer      → fa sterzare la ruota
        //               └── orientation → orienta l’asse e la croce verso l’esterno
        //                       └── spin    → fa girare la ruota sul proprio asse
        const tire = leaf(
            `tire_${id}`,
            "cylinder",
            [0.5, 0.5, 0.5, 1],
            {
                s: [0.4, 0.2, 0.4]
            }
        );

        const external = leaf(
            `external_${id}`,
            "torus",
            [0.15, 0.15, 0.15, 1],
            {
                s: [0.4, 0.5, 0.4]
            }
        );

        const vertical = leaf(
            `vertical_spoke_${id}`,
            "cube",
            [0.15, 0.15, 0.15, 1],
            {
                t: [0, 0.12, 0],
                s: [0.05, 0.02, 0.3]
            }
        );

        const horizontal = leaf(
            `horizontal_spoke_${id}`,
            "cube",
            [0.15, 0.15, 0.15, 1],
            {
                t: [0, 0.12, 0],
                s: [0.3, 0.02, 0.05]
            }
        );
        // Tutte le primitive ruotano insieme
        const spin = node(`wheel_spin_${id}`, {}, [
            tire,
            external,
            vertical,
            horizontal
        ]);

        // La croce deve essere visibile sul lato esterno
        const orientation = node(`wheel_orientation_${id}`, {
            r: [z > 0 ? 90 : -90, 0, 0]
        }, [spin]);

        // Nodo per la sterzata
        const steer = node(`wheel_steer_${id}`, {
            r:[0,0,0],
        }, [
            orientation
        ]);

        // Posizione della ruota rispetto al rover
        return node(`wheel_${id}`, {
            t: [x, y, z]
        }, [steer]);
    }

    // Corpo centrale
    const body = leaf(
        "body",
        "cube",
        [0.8, 0.65, 0.50, 1],
        {
            t: [0, BODY_Y, 0],
            s: [BODY_LENGTH, BODY_HEIGHT, BODY_WIDTH]
        }
    );

    // Fari anteriori: cilindri con l'asse rivolto lungo +X.
    const headlight_right = leaf(
        "headlight_right",
        "cylinder",
        [0.5, 0.5, 0.5, 1],
        {
            t: [BODY_LENGTH / 2 + 0.04, 0.95, 0.55],
            r: [0, 0, -90],
            s: [0.18, 0.12, 0.18]
        }
    );

    const headlight_left = leaf(
        "headlight_left",
        "cylinder",
        [0.5, 0.5, 0.5, 1],
        {
            t: [BODY_LENGTH / 2 + 0.04, 0.95, -0.55],
            r: [0, 0, -90],
            s: [0.18, 0.12, 0.18]
        }
    );
    // Supporto destro
    const wheel_support_right = leaf(
        "wheel_support_right",
        "cube",
        [0.5, 0.5, 0.5, 1],
        {
            t: [0, 0.73, 0.72],
            s: [2.3, 0.18, 0.12]
        }
    );

    // Supporto sinistro
    const wheel_support_left = leaf(
        "wheel_support_left",
        "cube",
        [0.5, 0.5, 0.5, 1],
        {
            t: [0, 0.73, -0.72],
            s: [2.3, 0.18, 0.12]
        }
    );

    // Abbassa l'intero rover fino al contatto delle ruote con il terreno.
    return node("rover", { t: [0, -0.122, 0] }, [
        body,
        headlight_right,
        headlight_left,
        createSolarPanel(),
        createSampleBin(),
        createCameraMast(),

        wheel_support_right,
        wheel_support_left,

        // Ruote anteriori
        wheel("front_left", 0.9, 0.4, -0.85),
        wheel("front_right", 0.9, 0.4, 0.85),

        // Ruote centrali
        wheel("middle_left", 0, 0.4, -0.85),
        wheel("middle_right", 0, 0.4, 0.85),

        // Ruote posteriori
        wheel("rear_left", -0.9, 0.4, -0.85),
        wheel("rear_right", -0.9, 0.4, 0.85),

        crateArm()
    ]);
}
function build_scene() {
    return node("root", {}, [
        createGround(),
        createRover(),
        ...createRocks()
    ]);
}23


// ---------------------------------------------------------------------------
// Input. Keys that act while held (driving, steering, the joints) are kept in
// a set, and update() moves things by an amount proportional to the time
// that has passed, so that the speed does not depend on the frame rate or on
// the keyboard's repeat rate. Keys that act once go in on_key().
// ---------------------------------------------------------------------------

const held = new Set();

function on_key(key) {
    switch (key) {

        case '1':
        case '2':
        case '3':
        case '4':
            currentView = Number(key);
            break;

        case '0':
            // In seguito: una vista / quattro viste
            break;
        
        case 'x':
            steer_angle=0;
            break;
        case 'p':
            gripper_closed = !gripper_closed;

            if (gripper_closed) {
                grabRock();
            } else {
                dropRock();
            }

            break;
        case ' ':
            // In seguito: wireframe / solid / both
            break;
    }
}

// dy > 0 when the wheel is scrolled down (towards the user)
function on_wheel(dy) {
    zoom = Math.max(1, Math.min(60, zoom * (1 + dy / 1000)));
}

function update(dt) {
    // Avanzamento e retromarcia nella direzione del rover.
    const rover = find(scene, "rover");
    let speed = 0;
    if (held.has('w')) speed += DRIVE_SPEED;
    if (held.has('s')) speed -= DRIVE_SPEED;

    // Sterzata a sinistra
    if (held.has('a')) {
        steer_angle += STEER_SPEED * dt;
    }

    // Sterzata a destra
    if (held.has('d')) {
        steer_angle -= STEER_SPEED * dt;
    }

    // Limita l'angolo tra -35 e +35 gradi
    steer_angle = Math.max(
        -MAX_STEER,
        Math.min(MAX_STEER, steer_angle)
    );

    // La sterzata cambia la direzione del rover solo mentre si muove.
    const delta = steer_angle * Math.PI / 180;
    const omega = speed * Math.tan(delta) / AXLE_DISTANCE;
    rover.transform.rotation[1] += omega * dt * 180 / Math.PI;

    const distance = speed * dt;
    const heading = rover.transform.rotation[1] * Math.PI / 180;
    rover.transform.translation[0] += distance * Math.cos(heading);
    rover.transform.translation[2] -= distance * Math.sin(heading);

    // Ruote anteriori
    const frontLeft = find(scene, "wheel_steer_front_left");
    const frontRight = find(scene, "wheel_steer_front_right");

    frontLeft.transform.rotation[1] = steer_angle;
    frontRight.transform.rotation[1] = steer_angle;

    // Ruote posteriori: angolo opposto
    const rearLeft = find(scene, "wheel_steer_rear_left");
    const rearRight = find(scene, "wheel_steer_rear_right");

    rearLeft.transform.rotation[1] = -steer_angle;
    rearRight.transform.rotation[1] = -steer_angle;

    // Le ruote centrali rimangono dritte

    // Rotolamento: distanza / raggio da radianti a gradi.
    const spinAngle = distance / WHEEL_RADIUS * 180 / Math.PI;
    for (const axle of ["front", "middle", "rear"]) {
        const leftSpin = find(scene, `wheel_spin_${axle}_left`);
        const rightSpin = find(scene, `wheel_spin_${axle}_right`);

        // Gli assi locali delle ruote sui due lati hanno versi opposti.
        leftSpin.transform.rotation[1] += spinAngle;
        rightSpin.transform.rotation[1] -= spinAngle;
    }

    // Torretta: ruota tutto il braccio attorno a Y.
    const arm = find(scene, "arm");
    if (held.has('q')) arm.transform.rotation[1] += ARM_SPEED * dt;
    if (held.has('e')) arm.transform.rotation[1] -= ARM_SPEED * dt;
    arm.transform.rotation[1] = Math.max(
        -MAX_TURRET,
        Math.min(MAX_TURRET, arm.transform.rotation[1])
    );

    // Spalla: alza e abbassa il braccio ruotando attorno al perno Z.
    const shoulder = find(scene, "shoulder");
    if (held.has('u')) shoulder.transform.rotation[2] += ARM_SPEED * dt;
    if (held.has('j')) shoulder.transform.rotation[2] -= ARM_SPEED * dt;
    shoulder.transform.rotation[2] = Math.max(
        MIN_SHOULDER,
        Math.min(MAX_SHOULDER, shoulder.transform.rotation[2])
    );

    //Gomito i/k
    const elbow = find(scene,"elbow");
    if(held.has('i')) elbow.transform.rotation[2]+=ARM_SPEED * dt;
    if(held.has('k')) elbow.transform.rotation[2]-=ARM_SPEED * dt;
    elbow.transform.rotation[2] = Math.max(
        MIN_ELBOW,
        Math.min(MAX_ELBOW, elbow.transform.rotation[2])
    );

    //Polso o/l
    const wrist = find(scene,"wrist");
    if(held.has('o')) wrist.transform.rotation[1]+=ARM_SPEED * dt;
    if(held.has('l')) wrist.transform.rotation[1]-=ARM_SPEED * dt;

    // Mast: rotazione orizzontale attorno a Y con f/h.
    const mast = find(scene, "mast");
    if (held.has('f')) mast.transform.rotation[1] += MAST_SPEED * dt;
    if (held.has('h')) mast.transform.rotation[1] -= MAST_SPEED * dt;
    mast.transform.rotation[1] = Math.max(
        -MAX_MAST_PAN,
        Math.min(MAX_MAST_PAN, mast.transform.rotation[1])
    );

    // La testa guarda lungo +X: ruotando attorno a Z guarda in alto o in basso.
    const cameraHead = find(scene, "camera_head");
    if (held.has('t')) cameraHead.transform.rotation[2] += MAST_SPEED * dt;
    if (held.has('g')) cameraHead.transform.rotation[2] -= MAST_SPEED * dt;
    cameraHead.transform.rotation[2] = Math.max(
        MIN_MAST_TILT,
        Math.min(MAX_MAST_TILT, cameraHead.transform.rotation[2])
    );

    // Pinza: p cambia lo stato, update avvicina le dita alla posizione richiesta.
    const gripper_right = find(scene,"gripper_right");
    const gripper_left = find(scene,"gripper_left");
    const target = gripper_closed ? MIN_GRIPPER : MAX_GRIPPER;
    const step = GRIPPER_SPEED * dt;

    if (gripper_opening < target) {
        gripper_opening = Math.min(target, gripper_opening + step);
    } else {
        gripper_opening = Math.max(target, gripper_opening - step);
    }

    gripper_left.transform.translation[2] = -gripper_opening;
    gripper_right.transform.translation[2] = gripper_opening;
}

// ---------------------------------------------------------------------------

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function setup_input() {
    // Single characters are taken in lower case, so that caps lock or shift
    // do not leave a key held forever
    const key_of = event => event.key.length == 1 ? event.key.toLowerCase() : event.key;
    window.addEventListener("keydown", (event) => {
        if (!event.repeat) on_key(key_of(event));
        held.add(key_of(event));
    });
    window.addEventListener("keyup", (event) => held.delete(key_of(event)));
    window.addEventListener("blur", () => held.clear());
    canvas.addEventListener("wheel", (event) => {
        on_wheel(event.deltaY);
        event.preventDefault();     // don't let the page scroll as well
    });
}

function setup(shaders) {
    canvas = document.getElementById("gl-canvas");
    gl = setupWebGL(canvas);

    program = buildProgramFromSources(gl, shaders["flat.vert"], shaders["flat.frag"]);

    CUBE.init(gl);
    SPHERE.init(gl);
    CYLINDER.init(gl);
    PYRAMID.init(gl);
    TORUS.init(gl);

    scene = build_scene();
    console.log("Primitives in the scene: " + count_primitives(scene));
    setup_gui();
    resize();
    window.addEventListener("resize", resize);
    setup_input();

    gl.clearColor(0.1, 0.1, 0.12, 1.0);
    gl.enable(gl.DEPTH_TEST);

    window.requestAnimationFrame(animate);
}

function draw_primitive(primitive, mv) {
    gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_model_view"), false, flatten(mv));
    gl.uniform4fv(gl.getUniformLocation(program, "u_color"), primitive.colour);
    PRIMITIVES[primitive.geometry].draw(gl, program, gl.TRIANGLES);
}

let last_time;



// Viste: eye e target sono offset rispetto alla posizione del rover.
let currentView = 4;

const cameras = {
    1: {
        name: "Front",
        eye: [8, 1.5, 0],
        target: [0, 1, 0],
        up: [0, 1, 0]
    },
    2: {
        name: "Left",
        eye: [0, 1.5, 8],
        target: [0, 1, 0],
        up: [0, 1, 0]
    },
    3: {
        name: "Top",
        eye: [0, 8, 0],
        target: [0, 0, 0],
        up: [0, 0, -1]
    },
    4: {
        name: "Axonometric",
        eye: [5, 4, 5],
        target: [0, 1, 0],
        up: [0, 1, 0]
    }
};
//-----------------------
function animate(time) {
    window.requestAnimationFrame(animate);

    const dt = last_time === undefined ? 0 : (time - last_time) / 1000;
    last_time = time;
    update(dt);

    // One view only, over the whole canvas: an axonometric view, as an
    // example, without distortion whatever the shape of the window
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = canvas.width / canvas.height;
    const camera = cameras[currentView];
    const position = find(scene, "rover").transform.translation;

    const eye = vec3(
        position[0] + camera.eye[0],
        position[1] + camera.eye[1],
        position[2] + camera.eye[2]
    );
    const target = vec3(
        position[0] + camera.target[0],
        position[1] + camera.target[1],
        position[2] + camera.target[2]
    );

    const V = lookAt(
        eye,
        target,
        vec3(...camera.up)
    );
    //------------------------------------------
    const P = ortho(-aspect * zoom, aspect * zoom, -zoom, zoom, 1, 40);

    gl.useProgram(program);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_projection"), false, flatten(P));

    STACK.loadMatrix(V);
    draw(scene, draw_primitive);

    gl.useProgram(null);
}

loadShadersFromURLS(["flat.vert", "flat.frag"]).then(shaders => setup(shaders));
