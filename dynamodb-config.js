// DynamoDB helper for printer configuration
import https from 'https';

// You'll need to set these environment variables on the printer server
const API_ENDPOINT = process.env.AMPLIFY_API_ENDPOINT || 'https://s3h225ug5rfxliczg4sjrrdgaq.appsync-api.us-east-2.amazonaws.com/graphql';
const API_KEY = process.env.AMPLIFY_API_KEY || 'da2-7zkq35s6pfdmfb5xheu574fjdi';

/**
 * Fetch printer configuration from DynamoDB via AppSync
 * Returns a map of restaurantId -> array of printer IDs
 */
export async function fetchPrinterConfigFromDynamoDB() {
  // GraphQL query to get all restaurant-printer mappings and printer configs
  const query = `
    query GetPrinterConfig {
      listRestaurantPrinters(filter: { isActive: { eq: true } }) {
        items {
          id
          restaurantId
          restaurantName
          printerConfigId
          printerConfig {
            id
            printerId
            serial
            isActive
          }
        }
      }
    }
  `;

  try {
    const response = await makeGraphQLRequest(query);
    
    if (!response.data || !response.data.listRestaurantPrinters) {
      console.error('Invalid response from AppSync:', response);
      return null;
    }

    const items = response.data.listRestaurantPrinters.items || [];
    
    // Build the PRINTER_CONFIG array format
    // Each entry maps a printerId to a serial number
    const printerConfig = [];
    
    items.forEach(item => {
      if (!item.printerConfig || !item.printerConfig.isActive) {
        return; // Skip inactive printers
      }
      
      const printerId = item.printerConfig.printerId;
      const serial = item.printerConfig.serial;
      
      if (!printerId || !serial) {
        return; // Skip incomplete data
      }
      
      // Add an entry for this printerId -> serial mapping
      // Check if we already have this printerId to avoid duplicates
      if (!printerConfig.some(p => p.restaurantId === printerId)) {
        printerConfig.push({
          restaurantId: printerId,
          serial: serial
        });
      }
    });
    
    console.log('Fetched printer config from DynamoDB:', printerConfig);
    return printerConfig;
  } catch (error) {
    console.error('Error fetching printer config from DynamoDB:', error);
    return null;
  }
}

/**
 * Make a GraphQL request to AppSync
 */
function makeGraphQLRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      query,
      variables
    });

    const url = new URL(API_ENDPOINT);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'x-api-key': API_KEY
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (parsed.errors) {
            console.error('GraphQL errors:', parsed.errors);
            reject(new Error(parsed.errors[0]?.message || 'GraphQL error'));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(data);
    req.end();
  });
}

// Fallback hardcoded config (same as before)
export const FALLBACK_PRINTER_CONFIG = [
  { restaurantId: "local", serial: "2581021060600835" },
  { restaurantId: "worldfamous-skyler1", serial: "2581018070600248" },
  { restaurantId: "worldfamous-skyler2", serial: "2581019070600037" },
  { restaurantId: "worldfamous-printer2", serial: "2581019070600037" },
  { restaurantId: "worldfamous-downey-printer1", serial: "2581018080600059" },
  { restaurantId: "worldfamous-downey-printer2", serial: "2581018070600306" },
  { restaurantId: "worldfamous-bell-printer1", serial: "2581019090600209" },
  { restaurantId: "worldfamous-bell-printer2", serial: "2581018080600564" },
  { restaurantId: "worldfamous-market-printer", serial: "2581018070600273" },
  { restaurantId: "arth-printer-1", serial: "2581019070600083" },
  { restaurantId: "arth-printer-2", serial: "2581019090600186" },
  { restaurantId: "arth-printer-3", serial: "2581019070600090" },
];
