cmake_minimum_required (VERSION 2.8.11)
project (psp)

if (NOT PSP_WASM_BUILD)
	set(PSP_WASM_BUILD ON)
endif()

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include_directories("${CMAKE_SOURCE_DIR}/src/include")

if (PSP_WASM_BUILD)
	add_definitions(-DPSP_ENABLE_WASM)
	set(CMAKE_C_COMPILER emcc)
	set(CMAKE_CXX_COMPILER em++)
	set(CMAKE_TOOLCHAIN_FILE "$ENV{EMSCRIPTEN_ROOT}/cmake/Modules/Platform/Emscripten.cmake")
	set(CMAKE_AR emar)
	set(CMAKE_RANLIB emranlib)
	set(CMAKE_EXECUTABLE_SUFFIX ".js")
	list(APPEND CMAKE_PREFIX_PATH /usr/local)
	include_directories("/usr/local/include")
	include_directories("/boost_includes")

	set(EXTENDED_FLAGS " \
		--bind \
		--memory-init-file 0 \
		-s NO_EXIT_RUNTIME=1 \
		-s NO_FILESYSTEM=1 \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s NO_DYNAMIC_EXECUTION=2 \
		-s EXPORTED_FUNCTIONS=\"['_main']\" \
	")

	if(DEFINED ENV{PSP_DEBUG})
		set(OPT_FLAGS " \
			-O1 \
			-g4 \
			-s SAFE_HEAP=1 \
			-s DISABLE_EXCEPTION_CATCHING=0 \
			-s ASSERTIONS=2 \
			-s DEMANGLE_SUPPORT=1 \
		")
	else()
		set(OPT_FLAGS " \
			-O3 \
			-g0 \
		")
	endif()

	set(SYNC_MODE_FLAGS "-s ENVIRONMENT=node -s BINARYEN_ASYNC_COMPILATION=0 -s BINARYEN_METHOD='\"native-wasm\"' -s WASM=1")
	set(ASYNC_MODE_FLAGS "-s ENVIRONMENT=worker -s BINARYEN_ASYNC_COMPILATION=1 -s BINARYEN_METHOD='\"native-wasm\"' -s WASM=1")
	set(ASMJS_MODE_FLAGS "-s ENVIRONMENT=worker -s LEGACY_VM_SUPPORT=1 -s BINARYEN_ASYNC_COMPILATION=0 -s BINARYEN_METHOD='\"asmjs\"' -Wno-almost-asm -s WASM=0")
else()
	if(DEFINED ENV{PSP_DEBUG})
		set(OPT_FLAGS " \
			-O1 \
			-g3 \
		")
	else()
		set(OPT_FLAGS " \
			-O3 \
			-g0 \
		")
	endif()
	set(SYNC_MODE_FLAGS "")
	set(ASYNC_MODE_FLAGS "")
	set(ASMJS_MODE_FLAGS "")
endif()

set(CMAKE_C_FLAGS " \
	${CMAKE_C_FLAGS} \
	${EXTENDED_FLAGS} \
	${OPT_FLAGS} \
")

set (SOURCE_FILES
src/aggregate.cpp
src/aggspec.cpp
src/arg_sort.cpp
src/base.cpp
src/base_impl_linux.cpp
src/base_impl_osx.cpp
src/base_impl_win.cpp
src/build_filter.cpp
#src/calc_agg_dtype.cpp
src/column.cpp
src/comparators.cpp
src/compat.cpp
src/compat_impl_linux.cpp
src/compat_impl_osx.cpp
src/compat_impl_win.cpp
src/config.cpp
src/context_base.cpp
src/context_grouped_pkey.cpp
src/context_handle.cpp
src/context_one.cpp
src/context_two.cpp
src/context_zero.cpp
src/custom_column.cpp
src/date.cpp
src/dense_nodes.cpp
src/dense_tree_context.cpp
src/dense_tree.cpp
src/dependency.cpp
src/extract_aggregate.cpp
src/filter.cpp
src/flat_traversal.cpp
src/gnode.cpp
src/gnode_state.cpp
src/histogram.cpp
src/logtime.cpp
src/mask.cpp
src/min_max.cpp
src/multi_sort.cpp
src/none.cpp
src/path.cpp
src/pivot.cpp
src/pool.cpp
src/port.cpp
src/raii.cpp
src/raii_impl_linux.cpp
src/raii_impl_osx.cpp
src/raii_impl_win.cpp
src/range.cpp
src/rlookup.cpp
src/scalar.cpp
src/schema_column.cpp
src/schema.cpp
src/slice.cpp
src/sort_specification.cpp
src/sparse_tree.cpp
src/sparse_tree_node.cpp
src/step_delta.cpp
src/storage.cpp
src/storage_impl_linux.cpp
src/storage_impl_osx.cpp
src/storage_impl_win.cpp
src/sym_table.cpp
src/table.cpp
src/time.cpp
src/traversal.cpp
src/traversal_nodes.cpp
src/tree_context_common.cpp
src/utils.cpp
src/update_task.cpp
src/vocab.cpp
)

set(CMAKE_CXX_FLAGS " -std=c++0x ${CMAKE_CXX_FLAGS} ${CMAKE_C_FLAGS}")

add_library(psp ${SOURCE_FILES})
set_target_properties(psp PROPERTIES COMPILE_FLAGS "${ASYNC_MODE_FLAGS}")

if (PSP_WASM_BUILD)
	add_executable(perspective.async src/main.cpp)
	target_link_libraries(perspective.async psp "${ASYNC_MODE_FLAGS}")
	set_target_properties(perspective.async PROPERTIES COMPILE_FLAGS "${ASYNC_MODE_FLAGS}")
	set_target_properties(perspective.async PROPERTIES RUNTIME_OUTPUT_DIRECTORY "./build/")
	set_target_properties(perspective.async PROPERTIES OUTPUT_NAME "psp.async")

	add_executable(perspective.sync src/main.cpp)
	target_link_libraries(perspective.sync psp "${SYNC_MODE_FLAGS}")
	set_target_properties(perspective.sync PROPERTIES COMPILE_FLAGS "${SYNC_MODE_FLAGS}")
	set_target_properties(perspective.sync PROPERTIES RUNTIME_OUTPUT_DIRECTORY "./build/")
	set_target_properties(perspective.sync PROPERTIES OUTPUT_NAME "psp.sync")
	add_dependencies(perspective.sync perspective.async)

	add_executable(perspective.asm src/main.cpp)
	target_link_libraries(perspective.asm psp "${ASMJS_MODE_FLAGS}")
	set_target_properties(perspective.asm PROPERTIES COMPILE_FLAGS "${ASMJS_MODE_FLAGS}")
	set_target_properties(perspective.asm PROPERTIES RUNTIME_OUTPUT_DIRECTORY "./build/")
	set_target_properties(perspective.asm PROPERTIES OUTPUT_NAME "psp.asmjs")
	add_dependencies(perspective.asm perspective.sync)
endif()


function (psp_build_dep name cmake_file)
	configure_file(${cmake_file} ${name}-download/CMakeLists.txt)
	execute_process(COMMAND ${CMAKE_COMMAND} -G "${CMAKE_GENERATOR}" .
			RESULT_VARIABLE result
			WORKING_DIRECTORY ${CMAKE_BINARY_DIR}/${name}-download )
	if(result)
		message(FATAL_ERROR "CMake step for ${name} failed: ${result}")
	endif()
	execute_process(COMMAND ${CMAKE_COMMAND} --build .
			RESULT_VARIABLE result
			WORKING_DIRECTORY ${CMAKE_BINARY_DIR}/${name}-download )
	if(result)
		message(FATAL_ERROR "Build step for ${name} failed: ${result}")
	endif()
	add_subdirectory(${CMAKE_BINARY_DIR}/${name}-src
			${CMAKE_BINARY_DIR}/${name}-build
			EXCLUDE_FROM_ALL)
endfunction()

if (NOT PSP_WASM_BUILD)
	## Build Gtest
	## Perhaps we need this on windows -> set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
	psp_build_dep("googletest" "GTest.txt.in")
	psp_build_dep("tbb" "TBB.txt.in")
	add_subdirectory(test)
endif()