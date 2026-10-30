import { Module } from '@medusajs/framework/utils'
import InPersonModuleService from './service'

export const IN_PERSON_MODULE = 'in_person'

export default Module(IN_PERSON_MODULE, {
  service: InPersonModuleService,
})
