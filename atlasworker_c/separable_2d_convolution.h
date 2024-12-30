#ifndef S2C_H
// s2c: separable 2d convolution

static inline float u8_to_f32(uint8_t x)
{
	return (float)x * (1.0f/255.0f);
}

static inline uint8_t f32_to_u8(float x)
{
	int i = floorf(x*256.0f);
	if (i < 0) i = 0;
	if (i > 255) i = 255;
	return (uint8_t)i;
}

static float* s2c_kernel;
static float* s2c_f32_scratch_space;
static int s2c_kernel_radius;
static int s2c_max_width;
static int s2c_max_height;

// returns a `float*` array with the length `2*kernel_radius+1`; you must fill
// this out with the kernel which center lies at index `kernel_radius`.
PLEASE_EXPORT float* s2c_setup(int kernel_radius, int max_width, int max_height)
{
	assert(kernel_radius >= 1);
	s2c_kernel_radius = kernel_radius;
	const size_t kernel_size = kernel_radius + kernel_radius + 1;
	s2c_kernel = heap_alloc_f32(kernel_size);
	s2c_max_width = max_width;
	s2c_max_height = max_height;
	const size_t max_scratch_pixels = max_width * max_height;
	//const size_t max_scratch_pixels = max_width * (max_height - 2*kernel_radius);
	// XXX ^^^ use this instead? should be safe due to the "empty border"
	// assumption
	s2c_f32_scratch_space = heap_alloc_f32(max_scratch_pixels);
	return s2c_kernel;
}

// perform in-place separable 2d convolution. NOTE: the image input is assumed
// to be blank within kernel radius of the border; presently a safe assumption
// because it's used for gaussian blurs and we have no use for cropped blurs.
PLEASE_EXPORT void s2c_execute(uint8_t* image, int width, int height, int stride)
{
	assert((width <= s2c_max_width) && (height <= s2c_max_height));
	float* const ssp0 = s2c_f32_scratch_space;
	float* const ssp0_end = ssp0+(width*height);
	const int R = s2c_kernel_radius;
	const int R2 = 2*R;
	const int R21 = R2+1;
	const float* K = s2c_kernel;
	const float* Kend = K+R21;

	// first pass; X-axis convolution; result is written to scratch with
	// x/y axes swapped (meaning the 2nd pass Y-convolution can read from
	// scratch in X-direction)
	const int y0 = R;
	const int y1 = height-R;
	const int dy = y1-y0;
	const int scratch_stride = dy;
	int pyoff = stride*y0;
	for (int yi = 0; yi < dy; ++yi, pyoff+=stride) {
		float* sp = ssp0 + yi;
		const uint8_t* pb = image + pyoff;
		const uint8_t* pbend = pb + stride;
		for (int x = 0; x < width; ++x, sp+=scratch_stride) {
			const int k0 = ((x<R) ? (R-x) : 0);
			const float* k = K + k0;
			const int km = R21-k0;
			const int p0 = ((x<R) ? 0 : (x-R));
			const uint8_t* p = pb + p0;
			const int nm = width-p0;
			const int n = km<nm ? km : nm;
			float sum = 0.0f;
			for (int i=0; i<n; ++i, ++p, ++k) {
				assert(pb <= p && p < pbend);
				assert(K <= k && k < Kend);
				sum += u8_to_f32(*p) * (*k);
			}
			assert(ssp0 <= sp && sp < ssp0_end);
			(*sp) = sum;
		}
	}

	//memset(image, 42, width*height); // tracer

	// second pass; Y-axis convolution
	for (int x = 0; x < width; ++x) {
		const float* const spb = ssp0 + x*scratch_stride;
		const float* const spb_end = spb+scratch_stride;
		assert(ssp0 <= spb && spb_end <= ssp0_end);
		uint8_t* p = image + x;
		for (int y = 0; y < height; ++y, p+=stride) {
			const int k0 = ((y<R2) ? (R2-y) : 0);
			const float* k = K + k0;
			const int km = R21-k0;
			const int s0 = ((y<R2) ? 0 : (y-R2));
			const float* const spb2 = spb + s0;
			const int nm = height-R2-s0;
			assert(nm > 0);
			const int n = km<nm ? km : nm;
			float sum = 0.0f;
			const float* sp = spb2;
			for (int i=0; i<n; ++i, ++sp, ++k) {
				assert(spb <= sp && sp < spb_end);
				assert(K <= k && k < Kend);
				sum += *(sp) * (*k);
			}
			(*p) = f32_to_u8(sum);
		}
	}
}

#define S2C_H
#endif
