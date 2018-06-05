/**
 * Copyright (c) 2017-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// See https://docusaurus.io/docs/site-config.html for all the possible
// site configuration options.

/* List of projects/orgs using your project for the users page */
const users = [
  // {
  //   caption: 'User1',
  //   // You will need to prepend the image path with your baseUrl
  //   // if it is not '/', like: '/test-site/img/docusaurus.svg'.
  //   image: '/img/perspective.svg',
  //   infoLink: 'https://jpmorganchase.hithub.io/perspective/',
  //   pinned: true,
  // },
];

const siteConfig = {
  title: 'Perspective' /* title for your website */,
  tagline: 'Streaming Analytics via WebAssembly',
  url: 'https://jpmorganchase.github.io/' /* your website url */,
  baseUrl: '/perspective/' /* base url for your project */,
  // For github.io type URLs, you would set the url and baseUrl like:
  //   url: 'https://facebook.github.io',
  //   baseUrl: '/test-site/',

  // Used for publishing and more
  projectName: 'perspective',
  organizationName: 'jpmorganchase',
  // For top-level user or org sites, the organization is still the same.
  // e.g., for the https://JoelMarcey.github.io site, it would be set like...
  //   organizationName: 'JoelMarcey'

  // For no header links in the top nav bar -> headerLinks: [],
  headerLinks: [
    {doc: 'installation', label: 'Docs'},
    {doc: 'viewer_api', label: 'API'},
    {blog: true, label: 'Blog'},
    {href: 'https://github.com/jpmorganchase/perspective/', label: 'GitHub'},
  ],

  // If you have users set above, you add it here:
  users,

  /* path to images for header/footer */
  headerIcon: 'img/perspective.svg',
  footerIcon: 'img/perspective.svg',
  favicon: 'img/favicon.png',

  /* colors for website */
  colors: {
    primaryColor: '#242526',
    secondaryColor: '#1A7DA1',
  },

  /* custom fonts for website */
  /*fonts: {
    myFont: [
      "Times New Roman",
      "Serif"
    ],
    myOtherFont: [
      "-apple-system",
      "system-ui"
    ]
  },*/

  // This copyright info is used in /core/Footer.js and blog rss/atom feeds.
  copyright:
    'Copyright © ' +
    new Date().getFullYear() +
    ' Perspective Authors',

  highlight: {
    // Highlight.js theme to use for syntax highlighting in code blocks
    theme: 'default',
  },

  // Add custom scripts here that would be placed in <script> tags
  scripts: [
    'https://buttons.github.io/buttons.js', 
    'https://unpkg.com/@jpmorganchase/perspective-examples/build/perspective.view.js',
    'https://unpkg.com/@jpmorganchase/perspective-examples/build/hypergrid.plugin.js',
    'https://unpkg.com/@jpmorganchase/perspective-examples/build/highcharts.plugin.js',
    'js/animation.js'
  ],

  stylesheets: [
    'https://unpkg.com/@jpmorganchase/perspective-examples/build/material.css'
  ],

  /* On page navigation for the current documentation page */
  onPageNav: 'separate',

  /* Open Graph and Twitter card images */
  ogImage: 'img/perspective.png',
  twitterImage: 'img/perspective.png',

  // You may provide arbitrary config keys to be used as needed by your
  // template. For example, if you need your repo's URL...
  //   repoUrl: 'https://github.com/facebook/test-site',
};

module.exports = siteConfig;
