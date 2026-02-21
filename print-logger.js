// print-logger.js
// Logs print operations to DynamoDB via AppSync
import https from 'https';

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
 * Create a print log entry in DynamoDB
 * @param {Object} params - Log parameters
 * @param {string} params.orderId - Order ID (optional)
 * @param {string} params.restaurantId - Restaurant ID
 * @param {string} params.printerSerial - Printer serial number (optional)
 * @param {string} params.status - Status (RECEIVED, PROCESSING, SENT_TO_PRINTER, PRINTER_ACCEPTED, PRINTED, FAILED, ERROR)
 * @param {string} params.stage - Stage (ORDER_RECEIVED, ORDER_VALIDATION, PRINTER_LOOKUP, JOB_CREATION, PRINTER_POLLING, PRINT_COMPLETE)
 * @param {string} params.message - Log message
 * @param {Object} params.errorDetails - Error details (optional)
 * @param {Object} params.orderData - Order data snapshot (optional)
 * @param {string} params.customerName - Customer name (optional)
 * @param {string} params.orderNumber - Order number (optional)
 * @param {string} params.environment - Environment (LOCAL, DEVELOP, PRODUCTION)
 * @param {string} params.printerStatus - Printer status (optional)
 * @param {number} params.processingTimeMs - Processing time in ms (optional)
 * @param {number} params.retryCount - Retry count (optional)
 * @param {Object} params.metadata - Additional metadata (optional)
 */
export async function createPrintLog(params) {
  const env = ENVIRONMENTS[params.environment?.toLowerCase()] || ENVIRONMENTS.production;
  
  const mutation = `
    mutation CreatePrintLog($input: CreatePrintLogInput!) {
      createPrintLog(input: $input) {
        id
        createdAt
      }
    }
  `;

  const variables = {
    input: {
      orderId: params.orderId || null,
      restaurantId: params.restaurantId,
      printerSerial: params.printerSerial || null,
      status: params.status,
      stage: params.stage,
      message: params.message,
      errorDetails: params.errorDetails ? JSON.stringify(params.errorDetails) : null,
      orderData: params.orderData ? JSON.stringify(params.orderData) : null,
      customerName: params.customerName || null,
      orderNumber: params.orderNumber || null,
      environment: (params.environment || 'PRODUCTION').toUpperCase(),
      printerStatus: params.printerStatus || null,
      processingTimeMs: params.processingTimeMs || 0,
      retryCount: params.retryCount || 0,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    }
  };

  try {
    await makeGraphQLRequest(mutation, variables, env.endpoint, env.apiKey);
    console.log('✅ Print log created:', params.status, params.stage, params.message);
  } catch (error) {
    // Don't throw - logging failures shouldn't break the printer system
    console.error('❌ Failed to create print log:', error.message);
  }
}

/**
 * Helper to log successful operations
 */
export async function logSuccess(params) {
  return createPrintLog({
    ...params,
    status: params.stage === 'PRINT_COMPLETE' ? 'PRINTED' : 'PROCESSING',
  });
}

/**
 * Helper to log errors
 */
export async function logError(params) {
  return createPrintLog({
    ...params,
    status: 'ERROR',
    errorDetails: {
      error: params.error instanceof Error ? {
        name: params.error.name,
        message: params.error.message,
        stack: params.error.stack,
      } : String(params.error),
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Make a GraphQL request to AppSync
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

    // Set a timeout to prevent hanging requests
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(data);
    req.end();
  });
}
