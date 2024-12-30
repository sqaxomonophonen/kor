// wasm helpers and things

#define WITH_DEBUG_PRINTF

#include <stddef.h>
#include <stdint.h>
#include <wasm_simd128.h>

#define NO_RETURN     __attribute__((noreturn))
//#define PLEASE_EXPORT __attribute__((used))
#define PLEASE_EXPORT __attribute__((visibility("default"))) // FUN FACT: "default" is not the default visibility

#define ALIGN_LOG2(lg2,x)    (((x)+(1<<lg2)-1) & ~((1<<lg2)-1))
#define MAX_ALIGNMENT_LOG2  (4) // the biggest WASM alignment seems to be 128-bit/16-byte
#define ARRAY_LENGTH(xs) (sizeof(xs)/sizeof((xs)[0]))

static inline void* memcpy(void* dst, const void* src, size_t n) { return __builtin_memcpy(dst, src, n); }
static inline void* memset(void* dst, int c, size_t n)           { return __builtin_memset(dst, c, n); }
static inline float floorf(float x)                              { return __builtin_floorf(x); }

static inline size_t strlen(const char* s)
{
	// there's no __builtin_strlen() (__builtin_strlen is defined though
	// but causes a linker error because "strlen" is not found)
	size_t len = 0;
	while (*(s++)) len++;
	return len;
}

// /////////////////////////////////
// MESSAGE
// a way to send a message back to JavaScript
// /////////////////////////////////

extern size_t js_print(const char* message); // implemented in JS

static int message_cursor;
static char message_buffer[1<<14];

static void reset_message(void)
{
	message_buffer[0] = 0;
	message_cursor = 0;
}

static void append_to_message(const char* string)
{
	const size_t n = strlen(string);
	const size_t remaining = (sizeof(message_buffer)-1) - message_cursor;
	const size_t can_write = n > remaining ? remaining : n;
	memcpy(message_buffer + message_cursor, string, can_write);
	message_cursor += can_write;
	message_buffer[message_cursor] = 0;
}

#ifdef WITH_DEBUG_PRINTF
#define STB_SPRINTF_IMPLEMENTATION
#include <stdarg.h>
#include "stb_sprintf.h"
static void DEBUG_PRINTF(const char* fmt, ...)
{
	reset_message();
	va_list ap;
	va_start(ap, fmt);
	message_cursor += stbsp_vsnprintf(message_buffer+message_cursor, sizeof(message_buffer)-message_cursor, fmt, ap);
	va_end(ap);
	js_print(message_buffer);

}
#else
#define DEBUG_PRINTF(...)
#endif

// /////////////////////////////////
// ASSERT
// /////////////////////////////////

extern size_t js_panic(const char* message); // implemented in JS

NO_RETURN static void handle_failed_assertion(const char* failed_predicate, const char* location)
{
	reset_message();
	append_to_message("ASSERTION FAILED {{{ ");
	append_to_message(failed_predicate);
	append_to_message(" }}} at ");
	append_to_message(location);
	js_panic(message_buffer);
	__builtin_trap();
}

#define STR2(s) #s
#define STR(s) STR2(s)
#define assert(p) if (!(p)) { handle_failed_assertion(#p, __FILE__ ":" STR(__LINE__)); }

// /////////////////////////////////
// HEAP
// /////////////////////////////////

extern unsigned char __heap_base;
static size_t heap_bytes_allocated, saved_heap_bytes_allocated;
static int heap_is_saved;
static size_t mem_size;
extern size_t js_grow_memory(size_t); // implemented in JS

PLEASE_EXPORT void heap_reset(void)
{
	heap_bytes_allocated = 0;
}

PLEASE_EXPORT void heap_save(void)
{
	assert(!heap_is_saved && "TODO implement nested save/load, if that is what you want?");
	saved_heap_bytes_allocated = heap_bytes_allocated;
	heap_is_saved = 1;
}

PLEASE_EXPORT void heap_restore(void)
{
	assert(heap_is_saved);
	heap_bytes_allocated = saved_heap_bytes_allocated;
	heap_is_saved = 0;
}

static void heap_grow_64k(size_t delta_64k_pages)
{
	mem_size = js_grow_memory(delta_64k_pages);
	assert(mem_size > 0);
}

static size_t get_mem_size(void)
{
	if (mem_size == 0) heap_grow_64k(0);
	assert(mem_size > 0);
	return mem_size;
}


// allocate n<<align_log2 bytes aligned to 1<<align_log2
PLEASE_EXPORT void* heap_alloc(int align_log2, size_t n)
{
	const size_t n_bytes = n << align_log2;
	void* base = (void*)(ALIGN_LOG2(align_log2,(intptr_t)&__heap_base) + heap_bytes_allocated);
	intptr_t end = (intptr_t)base + n_bytes;
	intptr_t needed = end - get_mem_size();
	if (needed > 0) heap_grow_64k(ALIGN_LOG2(16,needed) >> 16);
	assert(end <= get_mem_size());
	heap_bytes_allocated += n_bytes;
	return base;
}

PLEASE_EXPORT float* heap_alloc_u8(size_t n)  { return heap_alloc(0,n); }
PLEASE_EXPORT float* heap_alloc_f32(size_t n) { return heap_alloc(2,n); }
PLEASE_EXPORT size_t get_ptr_size(void) { return sizeof(void*); }
PLEASE_EXPORT void* heap_alloc_ptr(size_t n)
{
	_Static_assert(sizeof(void*)==4, "wasm64? be careful about Uint32Array assumptions... see also get_ptr_size()");
	return heap_alloc(2,n);
}


#if 1
#define STBIRDEF PLEASE_EXPORT
#define STBIR_ASSERT(p) assert(p)
#define STBIR_MALLOC(size,user_data)    heap_alloc(MAX_ALIGNMENT_LOG2,size)
#define STBIR_FREE(ptr,user_data)       ((void)ptr)
#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"
#endif

PLEASE_EXPORT void selftest_assertion_failure(void)
{
	assert((4==5) && "this expression is false");
}

static int monochrome_bitmap_width, monochrome_bitmap_height;
static void* monochrome_bitmap_pixels;
PLEASE_EXPORT void* allocate_and_set_current_monochrome_bitmap(int width, int height)
{
	monochrome_bitmap_pixels = heap_alloc_u8(width*height);
	monochrome_bitmap_width = width;
	monochrome_bitmap_height = height;
	return monochrome_bitmap_pixels;
}

PLEASE_EXPORT void resize_multiple_monochrome_subbitmaps(int num, int src_w, int src_h, int dst_w, int dst_h, double scale, void** io_ptr_pairs, int stride_in_bytes)
{
	assert(num > 0);
	static STBIR_RESIZE resize;
	heap_save();
	stbir_resize_init(&resize, io_ptr_pairs[0], src_w, src_h, stride_in_bytes, io_ptr_pairs[1], dst_w, dst_h, stride_in_bytes, STBIR_1CHANNEL, STBIR_TYPE_UINT8);


	// assume blackness outside of bbox; also allows bbox to
	// stbir_set_input_subrect() to be larger than src_w/h
	stbir_set_edgemodes(&resize, STBIR_EDGE_ZERO, STBIR_EDGE_ZERO);

	// TODO?
	#if 0
	stbir_set_input_subrect
	 - based on `scale` input
	 - range is [0;1] but also beyond.. 
	#endif
	// stbir_set_filters // uses "mitchell" for downsampling by default

	stbir_build_samplers(&resize); // redundant...? stbir_resize_extended() calls it if needed...
	for (int i=0; i<num; ++i) {
		if (i > 0) {
			stbir_set_buffer_ptrs(
				&resize,
				io_ptr_pairs[i*2], stride_in_bytes,
				io_ptr_pairs[i*2+1], stride_in_bytes);
		}
		stbir_resize_extended(&resize);
	}

	heap_restore();
}

#include "separable_2d_convolution.h"
