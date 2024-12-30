// web_main.mjs :: main entry point

const assert = (p,m) => { console.assert(p,m); if(!p) throw "ASSERTION FAILED"; }
const panic = (m) => { console.error(m); throw "PANIC"; }

function image_bitmap_to_image(image_bitmap) {
	let canvas = document.createElement("canvas");
	let ctx = canvas.getContext("2d");
	canvas.width = image_bitmap.width;
	canvas.height = image_bitmap.height;
	ctx.drawImage(image_bitmap, 0, 0);
	let img = new Image();
	img.src = canvas.toDataURL();
	return img;
}

const u8arr_bitmap_to_image = (width, height, u8arr) => new Promise((resolve,reject) => {
	assert(u8arr.length === (width*height), "mismatch between width*height and u8arr length");
	let d = new ImageData(width, height);
	let dd = d.data;
	const npix = u8arr.length;
	for (let i=0; i<npix; ++i) {
		const v = u8arr[i];
		dd[i*4+0] = v;
		dd[i*4+1] = v;
		dd[i*4+2] = v;
		dd[i*4+3] = 255;
	}
	createImageBitmap(d).then(b => {
		resolve(b);
	});
});

const CUSTOM_CODEPOINT_BOX = -1;
const CUSTOM_CODEPOINT_RANGE = [CUSTOM_CODEPOINT_BOX,CUSTOM_CODEPOINT_BOX];

const DEFAULT_ATLAS_HDR_CONFIG = [
	null,
	{
		scale: 0.6,
		blur_radius: 4,
		blur_variance: 1,
		pre_multiplier: 1,
	},
	{
		scale: 0.4,
		blur_radius: 10,
		blur_variance: 1,
		pre_multiplier: 1,
	},
	{
		scale: 0.2,
		blur_radius: 32,
		blur_variance: 1,
		pre_multiplier: 1,
	},
];

const CODEPOINT_RANGES_LATIN1 = [[0x20,0x7e],[0xa0,0xff]];
const DEFAULT_CODEPOINT_RANGES = CODEPOINT_RANGES_LATIN1;

const DEFAULT_ATLAS_CONFIG = {
	codepoint_ranges: DEFAULT_CODEPOINT_RANGES,
	hdr_config: DEFAULT_ATLAS_HDR_CONFIG,
	terminal_font_set: [
		"27###face###monospace",
		"18###face###monospace",
	]
};

const decode_font_identifier = (font_identifier) => {
	const xs = font_identifier.split("###");
	assert(xs.length === 3);
	const font = {
		size:   parseInt(xs[0],10),
		source: xs[1],
		ref:    xs[2],
	};
	return font;
};

const encode_font_identifier = (font) => {
	assert(typeof font.size === "number");
	assert(Math.round(font.size) === font.size, `font.size must be an integer, got ${font.size}`);
	assert(font.source==="face" || font.source==="url");
	assert(typeof font.ref === "string");
	return `${font.size}###${font.source}###${font.ref}`;
};

let _atlasworker = null;
let _atlasworker_rpc = null;

function atlasworker() {
	assert(_atlasworker!==null, "atlasworker not yet initialized?");
	return _atlasworker;
}

function atlasworker_rpc() {
	assert(_atlasworker_rpc!==null, "atlasworker/rpc not yet initialized?");
	return _atlasworker_rpc(...arguments);
}

const start_atlasworker = () => new Promise((resolve,reject) => {
	const worker_src = "./web_atlasworker.mjs";
	_atlasworker = new Worker(worker_src, {type:"module"}); // XXX:URLHARDCODED
	let serial_counter = 0;
	let serial_map = {};
	atlasworker().onerror = (error) => {
		console.error("XXX atlasworker threw an error. i'll print it shortly but please don't get your hopes up. because at the time of writing the error contains /absolutely no information of value/; no line number; no error message (unless you consider \"error\" an error message); this is both Firefox and Chrome btw; even syntax errors, and ES6 module import errors are reported in the same unhelpful way; I remember a time when JS error handling was /this/ awful and I think it was called Internet Explorer 4. good luck finding the error! because neither me nor your browser can help! :-(");
		console.error(error);
		// specs say that this /could/ be an ErrorEvent? but none of these fields are defined
		// (https://html.spec.whatwg.org/multipage/webappapis.html#errorevent)
		panic("unhelpful error thrown in " + worker_src);
	};
	atlasworker().onmessage = (message) => {
		const data = message.data;
		if (data.status === "READY") {
			_atlasworker_rpc = function(fn) {
				return new Promise((resolve,reject) => {
					const serial = ++serial_counter;
					const args = [...arguments].slice(1);
					atlasworker().postMessage({fn,serial,args});
					serial_map[serial] = {
						resolve,
						reject,
						signature: `${fn}(${JSON.stringify(args)})#${serial}`,
					};
				});
			};
			resolve(true);
			return;
		}
		if (data.status === "ERROR") {
			reject(data.error);
			return;
		}
		if (data.serial) {
			const h = serial_map[data.serial];
			if (h) {
				delete serial_map[data.serial];
				let {resolve,reject,signature} = h;
				if (data.ok) {
					resolve(data.result);
				} else {
					reject(`${signature} => ${data.error}`);
				}
				return;
			}
		}
		console.warn("TODO unhandled message from atlasworker: ", data);
	};
});

function make_webgl_canvas() {
	// thanks to:
	//   https://webglfundamentals.org/webgl/lessons/webgl-resizing-the-canvas.html
	// good article on how to make a canvas that draws 1:1 pixels regardless of
	// zoom level
	let canvas = document.createElement("canvas");

	canvas.style.display  = "block";
	canvas.style.width    = "100%";
	canvas.style.height   = "100vh";
	canvas.style.position = "absolute";
	canvas.style.left     = "0";
	canvas.style.top      = "0";

	canvas.our_resize_observer = new ResizeObserver((entries) => {
		const e = entries[0];
		const bs = e.devicePixelContentBoxSize;
		const width  = bs[0].inlineSize;
		const height = bs[0].blockSize;
		canvas.width  = canvas.our_width  = width;
		canvas.height = canvas.our_height = height;
	});
	canvas.our_resize_observer.observe(canvas, {box: "device-pixel-content-box"});

	canvas.our_gl = canvas.getContext("webgl2", {
		alpha: true,
		premultipliedAlpha: true,
		depth: false,
		stencil: false,
		antialias: false,
	});
	assert(canvas.our_gl, "unable to get webgl2 context");

	return canvas;
}

// gaussian bell curve at x for variance v and mean=0
const gaussian = (v,x) => Math.exp(-(x*x)/(2*v*v)) / Math.sqrt(2*Math.PI*v*v);

const make_fps_counter = (every_milliseconds) => {
	if (every_milliseconds === undefined) every_milliseconds = 1000;
	let t0 = null;
	let counter = 0;
	return () => {
		if (t0 === null) t0 = Date.now();
		counter++;
		const dt = Date.now() - t0;
		if (dt >= every_milliseconds) {
			const fps = (counter*dt*(1000/every_milliseconds)) / every_milliseconds;
			counter = 0;
			t0 = Date.now();
			return fps;
		}
		return null;
	};
}

function show_panic(e) {
	document.head.innerHTML = `
<style>
body {
	background: black;
	color: #f77;
	margin: 0;
}
.guru_meditation {
	margin: 2em;
	padding: 1em;
	border: 0.5em solid red;
	font-family: monospace;
}

.guru_meditation_message {
}

.guru_medititation_stack {
	margin-top: 2em;
	line-height: 2em;
}
</style>
`;
	let gs = document.getElementById("guru_meditations");
	if (!gs) document.body.innerHTML = '<div id="guru_meditations"></div>'
	gs = document.getElementById("guru_meditations");

	const g_em = document.createElement("div");
	g_em.className = "guru_meditation";
	gs.appendChild(g_em);

	const msg_em = document.createElement("div");
	msg_em.className = "guru_meditation_message";
	msg_em.innerText = e && e.toString() || "null error"; // XXX?
	g_em.appendChild(msg_em);

	const stack_em = document.createElement("div");
	stack_em.innerText = e.stack ?? "<no stack>";
	stack_em.className = "guru_medititation_stack";
	g_em.appendChild(stack_em);
}

// run unit tests (shouldn't take long; otherwise consider additional ways of
// testing)
function TEST(closure) { closure(); }
TEST(_=>{
	// test encode_font_identifier()/decode_font_identifier()
	const fs = [
		"27###face###monospace",
		"18###face###monospace",
		"18###url###https://foo.bar/baz",
	];
	for (const f0 of fs) {
		const f1 = decode_font_identifier(f0);
		const f2 = encode_font_identifier(f1);
		assert(f2 === f0);
	}
});

window.onload = () => {
	// handle errors thrown
	window.onerror = (message, source, lineno, colno, error) => {
		show_panic(error);
	};

	// handle async errors
	window.onunhandledrejection = (event) => {
		show_panic(event.reason);
	};

	Promise.all([
		start_atlasworker(),
	]).then(_=>{
		const atlas_config = DEFAULT_ATLAS_CONFIG;
		console.log(atlas_config);
		console.log(JSON.stringify(atlas_config));
		Promise.all([
			atlasworker_rpc("make_atlas", atlas_config),
		]).then(a=>{
			console.log("TODO");
			console.log(a);
		});
		/*
		let main_canvas = make_webgl_canvas();
		document.body.appendChild(main_canvas);
		const gl = main_canvas.our_gl;
		function draw() {
			gl.clearColor(0.0, 0.1, 0.2, 1.0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.viewport(0, 0, main_canvas.our_width, main_canvas.our_height);
			window.requestAnimationFrame(draw);
		}
		draw();
		*/
	});
};
