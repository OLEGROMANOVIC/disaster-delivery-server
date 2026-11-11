// PM2 process file required by Colyseus Cloud (must sit at the project root).
// One instance per region: the plans are 1 shared vCPU, and a single process
// needs no Redis. To scale out later, add REDIS_URI and raise `instances`.
module.exports = {
  apps: [{
    name: 'disaster-delivery',
    script: 'server.js',
    time: true,
    watch: false,
    instances: 1,
    exec_mode: 'fork',
    wait_ready: true,
    env_production: { NODE_ENV: 'production' }
  }]
};
