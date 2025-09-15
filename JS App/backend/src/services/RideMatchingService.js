import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import redisClient from '../config/redisClient.js';
// import amqp from "amqplib/callback_api.js"; 

const RADIUS_STEP = 5000; // 5 km increment
const MAX_RADIUS = 15000; // Max 15 km radius
const ACCEPT_WAIT = 30000;    // 30s wait for drivers to accept
const PREFIX = "ride:ignored:";

class RideMatchingService {

    // stores the data of the igonred drivers with reference to thr rideid
    async addIgonredDriver(rideId, driverId){
        const key = `${PREFIX}${rideId}`;
        await redisClient.redis.sadd(key, driverId);
        await redisClient.redis.expire(key, 1800); // 30 min TTL
    }

    async getIgnoredDrivers(rideId) {
        const key = `${PREFIX}${rideId}`;
        
        try {
            const drivers = await redisClient.redis.smembers(key);
            return drivers || [];  // always return an array
        } catch (err) {
            console.error(`Error fetching ignored drivers for ride ${rideId}:`, err);
            return [];  // fallback to empty array
        }
    }

    // search for the drivers in the area
    async searchForDrivers(lat, lon, rideId, radius = 3000, timeout = 5 * 60 * 1000) {

        const ignoredDrivers = new Set(await this.getIgnoredDrivers(rideId));
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            // 1. Fetch drivers from C++ executable
            const drivers = await this.searchDriversInRadius(lat, lon, radius);

            // refresh ignored list ---------------
            const newIgnored = await this.getIgnoredDrivers(rideId);
            newIgnored.forEach(d => ignoredDrivers.add(d.toString()));

            // 2. Filter ignored
            const filteredDrivers = drivers?.filter(
                d => !ignoredDrivers.includes(d.toString())
            ) || [];

            if (filteredDrivers.length > 0) {
                console.log("Drivers found:", filteredDrivers);

                // Push to queue so they get notifications
                await this.pushToNotificationQueue(filteredDrivers, rideId);

                // Wait for accept within 30s
                const accepted = await this.waitForAcceptance(rideId, ACCEPT_WAIT);
                if (accepted) {
                    console.log(`Ride ${rideId} accepted by driver ${accepted}`);
                    return;
                }

                console.log(`No acceptance for ride ${rideId} in ${radius / 1000} km.`);
            } else {
                console.log(`No drivers found in ${radius / 1000} km.`);
            }

            // Expand search radius if possible
            if (radius < MAX_RADIUS) {
                radius += RADIUS_STEP;
                console.log(`Expanding search radius to ${radius / 1000} km`);

                // Sleep here only after finishing one radius cycle (10 seconds sleep)
                await new Promise(res => setTimeout(res, 10000));
            } else {
                console.log(`Ride ${rideId}: No drivers accepted even after max radius`);
                await this.notifyRiderAboutTimeout(rideId);
                return;
            }
        }

        // Timeout exceeded
        await this.notifyRiderAboutTimeout(rideId);
    }


    // wait for acceptance within a given window
    async waitForAcceptance(rideId, waitMs) {
        return new Promise((resolve) => {
            let resolved = false;

            // Poll Redis for acceptance flag
            const interval = setInterval(async () => {
                const driverId = await redisClient.redis.get(`ride:accepted:${rideId}`);
                if (driverId) {
                    clearInterval(interval);
                    resolved = true;
                    resolve(driverId); // driver who accepted
                }
            }, 2000); // check every 2s

            // End after waitMs
            setTimeout(() => {
                if (!resolved) {
                    clearInterval(interval);
                    resolve(null); // no acceptance
                }
            }, waitMs);
        });
    }


    // Execute the C++ search for nearby drivers (--------- working fine ---------)
    async searchDriversInRadius(lat, lon, radius) {
        
        // Get the current file path
        const __filename = fileURLToPath(import.meta.url);

        // Get the directory name of the current file
        const __dirname = path.dirname(__filename);

        // Now you can use __dirname like in CommonJS
        const execPath = path.join(__dirname, "../../../../CPP App/ride_app.exe");  // Path to C++ executable
        
        const key = "users:location";  // example Redis key

        // Pass args in the exact order C++ expects: key, lon, lat, radius, unit
        const args = ['georadius', key, lon.toString(), lat.toString(), radius.toString(), 'km'];

        console.log(`Executing: ${execPath} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            execFile(execPath, args, { env: process.env }, (error, stdout, stderr) => {
                console.log('STDOUT:', stdout);
                console.log('STDERR:', stderr);

                if (error) {
                    console.error(`Error executing C++ file: ${stderr || error.message}`);
                    return reject(error);
                }

                try {
                    // Parse lines and remove empty lines
                    const drivers = stdout.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.startsWith('- '))
                        .map(line => line.slice(2).trim());

                    resolve(drivers);
                } catch (parseErr) {
                    reject(parseErr);
                }
            });
        });
    }

    // Push driver notifications to RabbitMQ queue
    // async pushToNotificationQueue(drivers, rideId) {

    //     amqp.connect('amqp://localhost', function(error0, connection) {
    //         if (error0) {
    //             throw error0;
    //         }
    //         connection.createChannel(function(error1, channel) {
    //             if (error1) {
    //                 throw error1;
    //             }
    //             const queue = 'ride_notifications';

    //             // Send each driver info to the queue
    //             drivers.forEach((driverId) => {
    //                 const msg = JSON.stringify({ rideId, driverId });
    //                 channel.sendToQueue(queue, Buffer.from(msg));
    //                 console.log(`Queued notification → driver ${driverId} for ride ${rideId}`);
    //             });
    //         });
    //     });
    // }

    // Notify rider if no drivers were found in time ---- (Dhaval)
    async notifyRiderAboutTimeout(rideId) {
        console.log(`Rider ${rideId} notified: No drivers available in time.`);
    }


}
export default new RideMatchingService();