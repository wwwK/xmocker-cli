'use strict'
const extname = require('path').extname
const faker = require('faker')
const thenify = require('thenify')
const proxy = require('http-proxy').createProxyServer({changeOrigin: true})

const db = require('../db')
const util = require('../util')
const common = require('../util/common')

proxy.web = thenify(proxy.web.bind(proxy))

const proj = require('./index').proj

const apiModel = db.apiModel
const apiBase = db.apiBase
const formatEntranceParam = util.formatEntranceParam
const getDeepVal = common.getDeepVal
const randomCode = common.randomCode
const repeatTime = proj.repeatTime || 1

module.exports = {
  getApi: sendApiData,
  addApi: sendApiData,
  editApi: sendApiData,
  deleteApi: sendApiData,
  getProjectApiList: getProjectApiList,
  reloadDatabase: reloadDatabase,
  setApiStatus: setApiStatus,
  getValStatus: getValStatus,
  proxyTo: proxyTo,
}

let projectId = proj._id || ''
let apiList
let apiStatus = {}
// 代理
let proxyReg = []
let proxyTable = proj.proxyTable || []
proxyTable.forEach(function (p) {
  proxyReg.push({reg: new RegExp(p.api), target: p.target})
})

// 获取当前项目所有的api列表，存储到内存中
async function getProjectApiList (ctx, next) {
  // if (!isXHR(ctx)) return next()

  let api
  if (!apiList) {
    try {
      apiList = await apiBase.cfind({ project: projectId }).sort({ name: 1 }).exec()
    } catch (e) {
      return resError(ctx, '后台错误')
    }
  }
  // 查询api
  let url = ctx.path
  let method = ctx.method
  let apiItem
  let params = Object.assign({}, ctx.query || {}, ctx.request.body)

  if (apiList.length) {
    for (let i = 0; i < apiList.length; i++) {
      api = apiList[i]
      let matchResult
      // 判断  method 是否相等
      if (api.method.toUpperCase() !== method) continue
      // 判断 url 是否相等

      if (/\/:/.test(api.url)) {
        matchResult = testUrl(api.url, url)
        if (!matchResult) continue
        Object.assign(params, matchResult)
      } else if (api.url !== url) {
        continue
      }

      // api 的path不存在，当名称和url相等时自动判断为当前url
      if (!api.path) {
        if (matchResult || api.name === url) {
          apiItem = api
          break
        }
      } else {
        let urlName = getDeepVal(params, api.path)
        if (urlName !== undefined && urlName === api.name) {
          apiItem = api
          break
        }
      }
    }
  }
  if (apiItem) {
    let conditionList
    try {
      conditionList = await apiModel.cfind({ baseid: apiItem._id }).exec()
    } catch (e) {
      return resError(ctx, '后台错误')
    }
    ctx.apiInfo = {
      reqApiBase: apiItem,
      reqApiModel: conditionList,
      params: params,
    }
  } else {
    return next()
  }

  return next()
}

// 通用函数
async function sendApiData (ctx, next) {
  if (!ctx.apiInfo) return next()

  let apiInfo = ctx.apiInfo || {}
  let { reqApiBase, reqApiModel, params } = apiInfo
  let data

  // 特殊状态查询
  let cApiStatus = apiStatus[reqApiBase._id]
  if (cApiStatus) {
    if (cApiStatus.code === 3) {
      return resError(ctx, '错误状态提示')
    } else if (cApiStatus.code === 2) {
      ctx.body = cApiStatus.data
      return
    }
  }

  let i, model, targetModel
  let result, dealedParams

  // 获取不同条件的api
  for (i = 0; i < reqApiModel.length; i++) {
    model = reqApiModel[i]
    let condition = model.condition || ''
    // 条件为空时设置为默认值
    // 格式化输入参数
    dealedParams = formatEntranceParam(params, model.inputParam)
    if (dealedParams._err) return resError(ctx, dealedParams._err)

    if (condition === '') {
      targetModel = model
      continue
    }

    result = execFunction(ctx, condition, dealedParams)

    if (result.error) {
      sendErrorMsg(ctx, result.message, {
        base: reqApiBase,
        model: model,
        params: params,
        dealedParams: dealedParams,
        e: result.error,
      })
      continue
    }

    if (result.result) {
      targetModel = model
      break
    }
  }

  if (targetModel) {
    data = Array.isArray(targetModel.data) ? targetModel.data[0] : targetModel.data
  }

  if (cApiStatus && cApiStatus.code === 1) {
    if (cApiStatus.times == null) {
      cApiStatus.times = 0
    } else {
      cApiStatus.times ++
    }
    if (cApiStatus.times < repeatTime && cApiStatus.lastData) {
      data = cApiStatus.lastData
    } else {
      data = setKeys(model.outputParam)
      cApiStatus.lastData = data
      cApiStatus.times = null
    }
  }

  let hisDetail = {
    base: reqApiBase,
    model: targetModel,
    params: params,
    dealedParams: dealedParams,
    res: data,
  }
  // 保存至历史记录
  if (targetModel) {
    sendHisData(ctx, '获取api数据成功：' + reqApiBase.name, hisDetail)
  } else {
    sendHisData(ctx, '获取api数据失败：' + reqApiBase.name, hisDetail)
  }

  if (!data) return resError(ctx, '无数据')
  ctx.body = data
  return next()
}

// 代理中间件
async function proxyTo (ctx, next) {
  for (let i = 0; i < proxyReg.length; i++) {
    if (proxyReg[i].reg.test(ctx.path)) {
      ctx.req.body = ctx.request.body
      await proxy.web(ctx.req, ctx.res, {target: proxyReg[i].target}).catch(function (d) {
        return resError(ctx, '抱歉，代理失败' + String(d))
      })
      return
    }
  }
  return resError('抱歉，代理失败')
}

// 执行函数
function execFunction (ctx, condition = '', dealedParams = {}) {
  let paramsArr = []
  if (condition.indexOf('return') < 0) condition = 'return ' + condition

  let keys = Object.keys(dealedParams)
  let cdFunction, result

  keys.forEach(function (key) {
    paramsArr.push(dealedParams[key])
  })
  keys.push(condition)
  try {
    cdFunction = new Function(...keys)
  } catch (e) {
    return {error: e, message: 'api分支判断条件函数不合法：' + condition}
  }

  // 调用函数
  try {
    result = cdFunction.apply(ctx, paramsArr)
  } catch (e) {
    return {error: e, message: 'api分支执行判断条件的函数时出现错误：' + condition}
  }

  return {result: result}
}

// 判断是否是xhr请求
function isXHR (ctx) {
  if (ctx.headers['content-type'] !== 'application/x-www-form-urlencoded' && ctx.headers['x-requested-with'] !== 'XMLHttpRequest') {
    if (ctx.headers['accept'] && ctx.headers['accept'].indexOf('application/json') < 0) {
      return
    } else if (extname(ctx.path).length < 5) {
      return
    }
  }
  return true
}

// 检测url是否匹配
function testUrl (str, url) {
  if (typeof str !== 'string' || typeof url !== 'string') return
  let cStr = str.replace(/\/:[^/]*\/?/, '/([^/]*)')
  let key = str.match(/\/:[^/]*\/?/)
  if (!key) return
  key = key[0].slice(2).replace('/', '')
  let reg = new RegExp(cStr, 'g')
  let r = reg.exec(url)
  if (!r) return
  let result = {}
  result[key] = r[1]
  return result
}

// 设置模板值
function setKeys (obj) {
  if (typeof obj !== 'object') return obj || {}
  let topResult = {}
  let keys = Object.keys(obj)

  keys.forEach(function (key) {
    let param = obj[key]

    if (param.type === 'array') {
      // 数组型
      let cnt = Math.random() * 100
      let result = []
      for (let i = 0; i < cnt; i++) {
        result.push(setKeys(param.child))
      }
      topResult[key] = result
    } else {
      if (param.type === 'object') {
        // 对象型
        let result = setKeys(param.child)
        topResult[key] = result
      } else {
        // 普通
        topResult[key] = generateData(param)
      }
    }
  })

  return topResult
}

function generateData (option) {
  let type = option.type || 'string'
  if (option.faker) {
    let func = getDeepVal(faker, option.faker)
    if (typeof func === 'function') return func()
  }
  let max = option.max == null ? 200 : ~~option.max
  let min = ~~option.min || 0
  let range = max - min
  let len = Math.round(Math.random() * range) + min

  if (type === 'string') {
    return randomCode(len)
  } else if (type === 'number') {
    return Math.round(Math.random() * range) + min
  } else if (type === 'boolean') {
    return true
  } else if (type === 'fixed') {
    return option.default
  } else {
    return null
  }
}

/**
 * 日志记录。包含内容
 * _type: 'out'
 * level: 10 日志等级
 * time: 时间戳
 * data: 内容
 * project: project名称
 * api： api名称
 * apiModel： 分支名称
 * projectId: 项目id
 * apiId: 接口Id
 * apiModelId: 分支id
 * req: 请求入参
 * reqParse: 转换后入参
 * res: 输出参数
 * args: process的启动参数
 * err: 错误详细信息
 * additional: 其他参数
 */
function sendErrorMsg (ctx, data, option = {}) {
  let base = option.base || {}
  let model = option.model || {}
  let e = option.e || {}

  let msg = {
    _type: 'error',
    time: +new Date(),
    args: {
      port: proj.port,
      fsPath: proj.path,
    },
    projectId: proj._id,
    project: proj.name,
    data: data,
    level: 6,
    apiId: base._id,
    api: base.name,
    apiModelId: model._id,
    apiModel: model.name,
    req: {
      params: option.params,
      url: ctx.url,
      method: ctx.method,
    },
    reqParsed: option.dealedParams,
    res: option.res,
    err: {
      msg: String(e),
      stack: String(e.stack),
    },
    additional: option.additional,
  }

  process.send(msg)
}
function sendHisData (ctx, data, option = {}) {
  let base = option.base || {}
  let model = option.model || {}

  let msg = {
    _type: 'his',
    time: +new Date(),
    args: {
      port: proj.port,
      fsPath: proj.path,
    },
    projectId: proj._id,
    project: proj.name,
    data: data,
    level: 8,
    apiId: base._id,
    api: base.name,
    apiModelId: model._id,
    apiModel: model.name,
    req: {
      params: option.params,
      url: ctx.url,
      method: ctx.method,
    },
    reqParsed: option.dealedParams,
    res: option.res,
  }
  msg = Object.assign(msg, data)
  process.send(msg)
}

let errorModel = JSON.stringify(proj.error) || '{"code": -1, "codeDesc":"${msg}", "codeDescUser":"${msg}"}'
let errorExp = /\$\{msg\}/gi
function resError (ctx, msg) {
  sendErrorMsg(ctx, msg)
  ctx.body = formatError(msg)
}

function formatError (msg) {
  let str = errorModel.replace(errorExp, msg)
  let obj
  try {
    obj = JSON.parse(str)
  } catch (e) {
    console.log('项目中错误串无法转换为obj。')
  }
  return obj
}

// 重启数据库
function reloadDatabase (msg) {
  let data = msg.data || []
  apiList = undefined
  if (!data.length) {
    Object.keys(db).forEach((key) => {
      db[key].loadDatabase()
    })
  } else {
    data.forEach(function (name) {
      if (db[name]) db[name].loadDatabase()
    })
  }
}

// 设置api状态 1表示随机值， 2表示固定值， 3表示错误值, 4表示清除
function setApiStatus (msg) {
  if (msg.id) {
    if (msg.status === 4) {
      apiStatus[msg.id] = undefined
    } else {
      apiStatus[msg.id] = {status: msg.status, code: msg.code, data: msg.data}
    }
  }
}

// 获取本api状态, 0表示正常， 1表示随机值， 2表示固定值， 3表示错误值
function getValStatus (msg) {

}

