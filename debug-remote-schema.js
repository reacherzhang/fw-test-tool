
import mysql from 'mysql2/promise';

const dbConfig = {
    host: '47.108.183.147',
    port: 3306,
    user: 'root',
    password: 's9yBmj3CraDpKLaGAN',
    database: 'iot_nexus_audit'
};

async function checkSchema() {
    console.log('Connecting to database...');
    const connection = await mysql.createConnection(dbConfig);

    try {
        console.log('\n--- Checking PROJECTS table ---');
        const [projects] = await connection.execute('SELECT * FROM projects LIMIT 1');
        if (projects.length > 0) {
            console.log('Keys in projects row:', Object.keys(projects[0]));
            console.log('Sample row:', JSON.stringify(projects[0], null, 2));
        } else {
            console.log('Projects table is empty');
        }

        console.log('\n--- Checking PROTOCOLS table ---');
        const [protocols] = await connection.execute('SELECT * FROM protocols LIMIT 1');
        if (protocols.length > 0) {
            console.log('Keys in protocols row:', Object.keys(protocols[0]));
            // Check specifically for project_id key
            const keys = Object.keys(protocols[0]);
            const projIdKey = keys.find(k => k.toLowerCase() === 'project_id');
            console.log(`Found project_id key: "${projIdKey}" (Type: ${typeof protocols[0][projIdKey]})`);
            console.log('Sample row:', JSON.stringify(protocols[0], null, 2));
        } else {
            console.log('Protocols table is empty');
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await connection.end();
    }
}

checkSchema();
