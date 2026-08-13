'use strict';

const express = require('express');

function installControlPlaneStaticRoutes({ app, adminPath }) {
  app.get(/^\/admin$/, (_req, res) => res.redirect(308, '/admin/'));
  app.use(
    '/admin',
    express.static(adminPath, {
      index: 'index.html',
      setHeaders: res => res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    })
  );
}

module.exports = { installControlPlaneStaticRoutes };
