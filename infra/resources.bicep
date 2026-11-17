// Everything in the environment's resource group. main.bicep describes the parameters.

param location string
param tags object
param resourceToken string
param principalId string
param appServiceSku string
param decisionSku string
param decisionCapacity int

// Built-in "Cognitive Services User": Entra ID inference on Foundry Models. "Cognitive Services OpenAI User"
// only covers OpenAI models, and Owner or Contributor grant no inference at all.
var cognitiveServicesUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'a97b65f3-24c7-4388-baec-2e87135dc908'
)

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${resourceToken}'
  location: location
  tags: tags
}

resource foundry 'Microsoft.CognitiveServices/accounts@2026-09-01' = {
  name: 'ai-${resourceToken}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  properties: {
    // Entra ID tokens only work against a resource's own subdomain endpoint.
    customSubDomainName: 'ai-${resourceToken}'
    // No API keys: the only way in is an Entra ID token (the app's managed identity, or your `az login`).
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-09-01' = {
  parent: foundry
  name: 'decision-1.1'
  sku: {
    name: decisionSku
    capacity: decisionCapacity
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'Microsoft-Decision-1.1'
      version: '1'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource appModelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identity.id, cognitiveServicesUserRoleId)
  scope: foundry
  properties: {
    roleDefinitionId: cognitiveServicesUserRoleId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource developerModelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(foundry.id, principalId, cognitiveServicesUserRoleId)
  scope: foundry
  properties: {
    roleDefinitionId: cognitiveServicesUserRoleId
    principalId: principalId
  }
}

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: 'plan-${resourceToken}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: appServiceSku
  }
  properties: {
    reserved: true
  }
}

resource web 'Microsoft.Web/sites@2025-03-01' = {
  name: 'app-${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      // Empty: App Service runs `npm start`. Until azd deploys the code it serves its placeholder page;
      // `node server.js` here would crash-loop on the empty site and stall azd's startup tracking.
      appCommandLine: ''
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/status'
      appSettings: [
        {
          name: 'FOUNDRY_ENDPOINT'
          value: foundry.properties.endpoint
        }
        {
          name: 'FOUNDRY_DEPLOYMENT'
          value: decision.name
        }
        {
          // Tells lib/foundry.js which identity to request tokens for from the App Service identity endpoint.
          name: 'AZURE_CLIENT_ID'
          value: identity.properties.clientId
        }
        {
          // App Service forwards traffic to PORT on the container's network interface, not to loopback.
          name: 'HOST'
          value: '0.0.0.0'
        }
      ]
    }
  }
}

// Container stdout in `az webapp log tail` and the portal's log stream.
resource webLogs 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: web
  name: 'logs'
  properties: {
    applicationLogs: {
      fileSystem: {
        level: 'Information'
      }
    }
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInDays: 3
        retentionInMb: 35
      }
    }
  }
}

// azd deploys with Entra ID, so FTP and basic-auth publishing stay off.
resource ftpPublishing 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: web
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource scmPublishing 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: web
  name: 'scm'
  properties: {
    allow: false
  }
}

output foundryEndpoint string = foundry.properties.endpoint
output decisionDeployment string = decision.name
output webName string = web.name
output webUri string = 'https://${web.properties.defaultHostName}'
