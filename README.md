# Perspective Restructure Ideas

## Highlights 

- C++ code is hoisted to be shared across all packages
- Lerna used to build the different libraries
- Node and Browser packages are split up
  - Runtimes are created by a shared package

## Getting Started

- Make sure you have `emcmake` in your `$PATH`
- Clone the branch and run `npm install`, this will also setup lerna
- Compile the C++ code by running `npm run compile`
- Run `npm run build` to build the runtimes

## Examples

Examples are in the `/examples/` directory. Open an example and run `npm start` to start the example. 
