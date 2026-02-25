// DynamoDB helper for printer configuration
import https from 'https';

// Environment configurations
const ENVIRONMENTS = {
  local: {
    endpoint: 'https://s3h225ug5rfxliczg4sjrrdgaq.appsync-api.us-east-2.amazonaws.com/graphql',
    apiKey: 'da2-7zkq35s6pfdmfb5xheu574fjdi'
  },
  develop: {
    endpoint: 'https://k2aa7szpyvfqznxlw3u4v35c2m.appsync-api.us-east-2.amazonaws.com/graphql',
    apiKey: 'da2-44g36v6iunecbki2s3jhxvoeyuh'
  },
  production: {
    endpoint: 'https://xcvbmegvdzcm3grnd44njlvwka.appsync-api.us-east-2.amazonaws.com/graphql',
    apiKey: 'da2-slym3gpah5hqncy5oh5bof44c4'
  }
};

/**
 * Determine environment from the origin/referer header
 * @param {string} origin - The origin or referer from the request
 * @returns {string} - 'local', 'develop', or 'production'
 */
export function getEnvironmentFromOrigin(origin) {
  if (!origin) {
    console.log('No origin provided, defaulting to production');
    return 'production';
  }

  const originLower = origin.toLowerCase();
  
  if (originLower.includes('localhost') || originLower.includes('127.0.0.1')) {
    console.log('Detected local environment from origin:', origin);
    return 'local';
  }
  
  if (originLower.includes('develop.d2g0w15slq5y17.amplifyapp.com')) {
    console.log('Detected develop environment from origin:', origin);
    return 'develop';
  }
  
  if (originLower.includes('orderthevessale.com') || 
      originLower.includes('main.d2g0w15slq5y17.amplifyapp.com')) {
    console.log('Detected production environment from origin:', origin);
    return 'production';
  }
  
  // Default to production for unknown origins
  console.log('Unknown origin, defaulting to production:', origin);
  return 'production';
}

/**
 * Fetch printer configuration from DynamoDB via AppSync
 * Returns a map of restaurantId -> array of printer IDs
 * @param {string} environment - 'local', 'develop', or 'production'
 */
export async function fetchPrinterConfigFromDynamoDB(environment = 'production') {
  const env = ENVIRONMENTS[environment];
  
  if (!env) {
    console.error('Invalid environment:', environment);
    return null;
  }
  
  console.log(`Fetching printer config from ${environment} environment:`, env.endpoint);
  console.log(`Fetching printer config from ${environment} environment:`, env.endpoint);
  
  // GraphQL query to get all restaurant-printer mappings and printer configs
  // Note: Not filtering by environment in the query because we need to handle null values
  // Will filter in JavaScript code instead
  const query = `
    query GetPrinterConfig {
      listRestaurantPrinters(filter: { 
        isActive: { eq: true }
      }) {
        items {
          id
          restaurantId
          restaurantName
          printerConfigId
          environment
          printerConfig {
            id
            printerId
            serial
            isActive
            environment
          }
        }
      }
    }
  `;

  try {
    const response = await makeGraphQLRequest(query, {}, env.endpoint, env.apiKey);
    
    if (!response.data || !response.data.listRestaurantPrinters) {
      console.error('Invalid response from AppSync:', response);
      return null;
    }

    const items = response.data.listRestaurantPrinters.items || [];
    
    // Build the PRINTER_CONFIG array format
    // Each entry maps a restaurantId to a serial number
    const printerConfig = [];
    
    items.forEach(item => {
      if (!item.printerConfig || !item.printerConfig.isActive) {
        return; // Skip inactive printers
      }
      
      // Filter by environment: include if environment matches OR if environment is null (legacy records)
      const itemEnv = item.environment || item.printerConfig.environment;
      if (itemEnv && itemEnv !== environment) {
        return; // Skip printers from different environments
      }
      
      const restaurantId = item.restaurantId; // The actual restaurant ID from the mapping
      const serial = item.printerConfig.serial;
      
      if (!restaurantId || !serial) {
        return; // Skip incomplete data
      }
      
      // Add an entry for this restaurantId -> serial mapping
      printerConfig.push({
        restaurantId: restaurantId,
        serial: serial
      });
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
 * @param {string} query - GraphQL query
 * @param {object} variables - GraphQL variables
 * @param {string} endpoint - AppSync endpoint URL
 * @param {string} apiKey - AppSync API key
 */
function makeGraphQLRequest(query, variables = {}, endpoint, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      query,
      variables
    });

    const url = new URL(endpoint);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'x-api-key': apiKey
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

/**
 * Migrate printers from one environment to another
 * Updates both PrinterConfig and RestaurantPrinter records
 * @param {string[]} printerIds - Array of PrinterConfig IDs to migrate
 * @param {string} sourceEnvironment - Source environment ('local', 'develop', or 'production')
 * @param {string} targetEnvironment - Target environment ('local', 'develop', or 'production')
 */
export async function migratePrintersEnvironment(printerIds, sourceEnvironment, targetEnvironment) {
  const env = ENVIRONMENTS[targetEnvironment];
  
  if (!env) {
    throw new Error('Invalid target environment');
  }

  console.log(`Migrating ${printerIds.length} printers from ${sourceEnvironment} to ${targetEnvironment}`);

  let updated = 0;
  let failed = 0;

  for (const printerId of printerIds) {
    try {
      // Update PrinterConfig
      const updatePrinterMutation = `
        mutation UpdatePrinterConfig($input: UpdatePrinterConfigInput!) {
          updatePrinterConfig(input: $input) {
            id
            environment
          }
        }
      `;

      const printerVariables = {
        input: {
          id: printerId,
          environment: targetEnvironment.toUpperCase()
        }
      };

      await makeGraphQLRequest(updatePrinterMutation, printerVariables, env.endpoint, env.apiKey);
      
      // Update all RestaurantPrinter mappings for this printer
      const listMappingsQuery = `
        query ListRestaurantPrinters($filter: ModelRestaurantPrinterFilterInput) {
          listRestaurantPrinters(filter: $filter) {
            items {
              id
              printerConfigId
            }
          }
        }
      `;

      const listVariables = {
        filter: {
          printerConfigId: { eq: printerId }
        }
      };

      const mappingsResponse = await makeGraphQLRequest(listMappingsQuery, listVariables, env.endpoint, env.apiKey);
      const mappings = mappingsResponse.data?.listRestaurantPrinters?.items || [];

      // Update each mapping
      for (const mapping of mappings) {
        const updateMappingMutation = `
          mutation UpdateRestaurantPrinter($input: UpdateRestaurantPrinterInput!) {
            updateRestaurantPrinter(input: $input) {
              id
              environment
            }
          }
        `;

        const mappingVariables = {
          input: {
            id: mapping.id,
            environment: targetEnvironment.toUpperCase()
          }
        };

        await makeGraphQLRequest(updateMappingMutation, mappingVariables, env.endpoint, env.apiKey);
      }

      console.log(`✓ Migrated printer ${printerId} and ${mappings.length} restaurant mapping(s)`);
      updated++;
    } catch (error) {
      console.error(`✗ Failed to migrate printer ${printerId}:`, error.message);
      failed++;
    }
  }

  return { updated, failed };
}
